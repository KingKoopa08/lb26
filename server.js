import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { bootstrapAdmin, digestToken, hashPassword, migrate, pool, validPassword, verifyPassword } from './db.js';
import { registerRoutes } from './routes.js';
import { registerEmailRoutes } from './email-routes.js';
import { registerAnalyticsRoutes } from './analytics-routes.js';
import { ISSUE_PAGES, PLANS, SEO_PATHS, renderActionPage, renderDistrict, renderIssue, renderLisa, renderPlan, renderPlansIndex, renderIssuesIndex } from './seo-pages.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 8098);
const canonicalHost = String(process.env.CANONICAL_HOST || 'ballayforcongress.com').toLowerCase();
const sessionHours = Math.max(1, Number(process.env.SESSION_TTL_HOURS || 12));
const comingSoonEnabled = process.env.COMING_SOON === 'true';
const loginAttempts = new Map();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((request, response, next) => {
  const host = String(request.hostname || '').toLowerCase();
  if (host === `www.${canonicalHost}` || host === 'lisaballayforcongress.com' || host === 'www.lisaballayforcongress.com') {
    return response.redirect(301, `https://${canonicalHost}${request.originalUrl}`);
  }
  next();
});
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '12mb', verify: (request, _response, buffer) => { request.rawBody = Buffer.from(buffer); } }));

function cookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map((item) => {
    const index = item.indexOf('=');
    return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1))];
  }));
}

function sessionCookie(token, maxAgeSeconds) {
  // Secure by default. The override supports the temporary direct-IP HTTP URL
  // until the campaign domain and HTTPS reverse proxy are ready.
  const secure = process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false' ? '; Secure' : '';
  return `lb26_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

async function readSession(request) {
  const token = cookies(request).lb26_admin;
  if (!token) return null;
  const result = await pool.query(`SELECT s.id, s.csrf_token, s.expires_at, u.id AS user_id, u.username, u.email, u.role FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.token_digest=$1 AND s.expires_at>now() AND u.active=true`, [digestToken(token)]);
  if (!result.rowCount) return null;
  pool.query('UPDATE admin_sessions SET last_seen_at=now() WHERE id=$1', [result.rows[0].id]).catch(() => {});
  return result.rows[0];
}

async function requireAdmin(request, response, next) {
  try {
    request.adminSession ||= await readSession(request);
    if (!request.adminSession) {
      if (request.originalUrl.startsWith('/api/')) return response.status(401).json({ error: 'Authentication required.' });
      const destination = request.originalUrl === '/preview' ? '?next=%2Fpreview' : '';
      return response.redirect(303, `/admin/login${destination}`);
    }
    next();
  } catch (error) { next(error); }
}

const ROLE_PERMISSIONS = {
  admin: ['dashboard', 'analytics', 'crm', 'email', 'events', 'export', 'users'],
  manager: ['dashboard', 'analytics', 'crm', 'email', 'events', 'export'],
  staff: ['dashboard', 'crm', 'email', 'events'],
  viewer: ['dashboard', 'analytics', 'crm:read', 'email:read', 'events:read'],
};

function hasPermission(session, permission) {
  const permissions = ROLE_PERMISSIONS[session?.role] || [];
  return permissions.includes(permission) || permissions.includes(permission.split(':')[0]);
}

function authorizeAdminApi(request, response, next) {
  const path = request.path;
  const read = request.method === 'GET';
  let permission = read ? 'crm:read' : 'crm';
  if (path === '/session') permission = null;
  else if (path.startsWith('/users')) permission = 'users';
  else if (path.startsWith('/analytics')) permission = 'analytics';
  else if (path.startsWith('/email')) permission = read ? 'email:read' : 'email';
  else if (path.startsWith('/events')) permission = read ? 'events:read' : 'events';
  else if (path.startsWith('/export')) permission = 'export';
  else if (path === '/dashboard') permission = 'dashboard';
  if (!permission || hasPermission(request.adminSession, permission)) return next();
  return response.status(403).json({ error: 'Your role does not have access to this action.' });
}

function loginAllowed(ip) {
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter((at) => now - at < 15 * 60 * 1000);
  loginAttempts.set(ip, recent);
  return recent.length < 10;
}

app.get('/health', async (_request, response) => {
  try {
    await pool.query('SELECT 1');
    response.json({ status: 'healthy', database: 'up' });
  } catch { response.status(503).json({ status: 'unhealthy', database: 'down' }); }
});

app.get('/admin/login', async (request, response, next) => {
  try {
    const destination = request.query.next === '/preview' ? '/preview' : '/admin';
    if (await readSession(request)) return response.redirect(303, destination);
    response.sendFile(path.join(root, 'admin', 'login.html'));
  } catch (error) { next(error); }
});

app.use(['/admin', '/api'], (_request, response, next) => {
  response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
});

app.get('/preview', requireAdmin, (_request, response) => response.redirect(303, '/'));

app.use(async (request, response, next) => {
  if (!comingSoonEnabled) return next();
  if (request.path === '/health' || request.path === '/analytics.js' || request.path === '/api/public/analytics' || request.path.startsWith('/admin') || request.path.startsWith('/api/admin') || request.path.startsWith('/api/webhooks')) return next();
  try {
    if (await readSession(request)) return next();
    if (request.method === 'GET' && request.path === '/') {
      response.setHeader('Cache-Control', 'no-store');
      return response.sendFile(path.join(root, 'coming-soon.html'));
    }
    return response.status(404).send('Not found');
  } catch (error) { return next(error); }
});

app.post('/admin/login', async (request, response, next) => {
  try {
    if (!loginAllowed(request.ip)) return response.status(429).send('Too many login attempts. Try again later.');
    const username = String(request.body.username || request.body.email || '').trim();
    const password = String(request.body.password || '');
    const destination = request.body.next === '/preview' ? '/preview' : '/admin';
    const result = await pool.query('SELECT id,username,email,password_hash FROM admin_users WHERE (lower(username)=lower($1) OR lower(email)=lower($1)) AND active=true', [username]);
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      loginAttempts.set(request.ip, [...(loginAttempts.get(request.ip) || []), Date.now()]);
      await pool.query('INSERT INTO audit_events (action,metadata,ip_address) VALUES ($1,$2,$3)', ['admin.login_failed', JSON.stringify({ username }), request.ip]);
      return response.redirect(303, `/admin/login?error=1${destination === '/preview' ? '&next=%2Fpreview' : ''}`);
    }
    loginAttempts.delete(request.ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionHours * 60 * 60 * 1000);
    await pool.query('INSERT INTO admin_sessions (user_id,token_digest,csrf_token,expires_at,ip_address,user_agent) VALUES ($1,$2,$3,$4,$5,$6)', [user.id, digestToken(token), csrfToken, expiresAt, request.ip, String(request.get('user-agent') || '').slice(0, 500)]);
    await pool.query('INSERT INTO audit_events (actor_user_id,action,ip_address) VALUES ($1,$2,$3)', [user.id, 'admin.login_succeeded', request.ip]);
    response.setHeader('Set-Cookie', sessionCookie(token, sessionHours * 60 * 60));
    response.redirect(303, destination);
  } catch (error) { next(error); }
});

app.use('/api/admin', requireAdmin, authorizeAdminApi);
app.get('/api/admin/session', (request, response) => response.json({ username: request.adminSession.username, role: request.adminSession.role, permissions: ROLE_PERMISSIONS[request.adminSession.role] || [], csrfToken: request.adminSession.csrf_token }));

app.get('/api/admin/users', async (_request, response, next) => {
  try {
    const result = await pool.query('SELECT id,username,role,active,created_at FROM admin_users ORDER BY active DESC, lower(username)');
    response.json({ users: result.rows, roles: Object.keys(ROLE_PERMISSIONS) });
  } catch (error) { next(error); }
});

app.post('/api/admin/users', async (request, response, next) => {
  try {
    if (request.get('x-csrf-token') !== request.adminSession.csrf_token) return response.status(403).json({ error: 'Invalid request token.' });
    const username = String(request.body.username || '').trim();
    const password = String(request.body.password || '');
    const role = String(request.body.role || 'staff');
    if (!/^[A-Za-z][A-Za-z0-9._-]{1,49}$/.test(username)) return response.status(400).json({ error: 'Username must be 2–50 characters and start with a letter.' });
    if (!validPassword(password)) return response.status(400).json({ error: 'Password must be at least 8 characters with an uppercase letter and special character.' });
    if (!ROLE_PERMISSIONS[role]) return response.status(400).json({ error: 'Invalid role.' });
    const result = await pool.query('INSERT INTO admin_users (username,password_hash,role) VALUES ($1,$2,$3) RETURNING id,username,role,active,created_at', [username, hashPassword(password), role]);
    await pool.query('INSERT INTO audit_events (actor_user_id,action,metadata,ip_address) VALUES ($1,$2,$3,$4)', [request.adminSession.user_id, 'admin.user_created', JSON.stringify({ userId: result.rows[0].id, username, role }), request.ip]);
    response.status(201).json({ user: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return response.status(409).json({ error: 'That username is already taken.' });
    next(error);
  }
});

app.patch('/api/admin/users/:id', async (request, response, next) => {
  try {
    if (request.get('x-csrf-token') !== request.adminSession.csrf_token) return response.status(403).json({ error: 'Invalid request token.' });
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: 'Invalid user.' });
    const found = await pool.query('SELECT id,username,role,active FROM admin_users WHERE id=$1', [id]);
    if (!found.rowCount) return response.status(404).json({ error: 'User not found.' });
    const current = found.rows[0];
    const role = request.body.role === undefined ? current.role : String(request.body.role);
    const active = request.body.active === undefined ? current.active : request.body.active === true;
    const password = request.body.password === undefined ? null : String(request.body.password);
    if (!ROLE_PERMISSIONS[role]) return response.status(400).json({ error: 'Invalid role.' });
    if (password !== null && !validPassword(password)) return response.status(400).json({ error: 'Password must be at least 8 characters with an uppercase letter and special character.' });
    if (id === Number(request.adminSession.user_id) && (!active || role !== 'admin')) return response.status(400).json({ error: 'You cannot deactivate or remove your own admin access.' });
    const otherAdmins = await pool.query("SELECT count(*)::int AS count FROM admin_users WHERE role='admin' AND active=true AND id<>$1", [id]);
    if (current.role === 'admin' && current.active && (!active || role !== 'admin') && otherAdmins.rows[0].count === 0) return response.status(400).json({ error: 'At least one active administrator is required.' });
    const result = password === null
      ? await pool.query('UPDATE admin_users SET role=$1,active=$2 WHERE id=$3 RETURNING id,username,role,active,created_at', [role, active, id])
      : await pool.query('UPDATE admin_users SET role=$1,active=$2,password_hash=$3 WHERE id=$4 RETURNING id,username,role,active,created_at', [role, active, hashPassword(password), id]);
    if (!active || password !== null || role !== current.role) await pool.query('DELETE FROM admin_sessions WHERE user_id=$1 AND id<>$2', [id, request.adminSession.id]);
    await pool.query('INSERT INTO audit_events (actor_user_id,action,metadata,ip_address) VALUES ($1,$2,$3,$4)', [request.adminSession.user_id, 'admin.user_updated', JSON.stringify({ userId: id, role, active, passwordReset: password !== null }), request.ip]);
    response.json({ user: result.rows[0] });
  } catch (error) { next(error); }
});

registerRoutes(app, { pool, requireAdmin });
registerEmailRoutes(app, { pool, requireAdmin });
registerAnalyticsRoutes(app, { pool, requireAdmin, readSession });

app.post('/admin/logout', requireAdmin, async (request, response, next) => {
  try {
    if (!request.body.csrf || request.body.csrf !== request.adminSession.csrf_token) return response.status(403).send('Invalid request token');
    await pool.query('DELETE FROM admin_sessions WHERE id=$1', [request.adminSession.id]);
    await pool.query('INSERT INTO audit_events (actor_user_id,action,ip_address) VALUES ($1,$2,$3)', [request.adminSession.user_id, 'admin.logout', request.ip]);
    response.setHeader('Set-Cookie', sessionCookie('', 0));
    response.redirect(303, '/admin/login');
  } catch (error) { next(error); }
});

app.get('/admin/admin.css', (_request, response) => response.sendFile(path.join(root, 'admin', 'admin.css')));
app.get('/admin/email.css', (_request, response) => response.sendFile(path.join(root, 'admin', 'email.css')));
app.get('/admin/users.css', (_request, response) => response.sendFile(path.join(root, 'admin', 'users.css')));
app.get('/admin/analytics.css', (_request, response) => response.sendFile(path.join(root, 'admin', 'analytics.css')));
app.get('/admin/admin.js', (_request, response) => response.sendFile(path.join(root, 'admin', 'admin.js')));
app.get('/admin', requireAdmin, (_request, response) => response.sendFile(path.join(root, 'admin', 'index.html')));
app.use('/assets', express.static(path.join(root, 'assets'), { maxAge: '1d' }));
app.get('/support.js', (_request, response) => response.sendFile(path.join(root, 'support.js')));
app.get('/public-crm.js', (_request, response) => response.sendFile(path.join(root, 'public-crm.js')));
app.get('/involvement.js', (_request, response) => response.sendFile(path.join(root, 'involvement.js')));
app.get('/involvement.css', (_request, response) => response.sendFile(path.join(root, 'involvement.css')));
app.get('/analytics.js', (_request, response) => response.sendFile(path.join(root, 'analytics.js')));
app.get('/meet-lisa', (_request, response) => response.redirect(301, '/lisa-ballay'));
app.get('/lisa-ballay', (_request, response) => response.send(renderLisa()));
app.get('/louisiana-district-2', (_request, response) => response.send(renderDistrict()));
app.get('/issues', (_request, response) => response.send(renderIssuesIndex()));
app.get('/issues/:slug', (request, response, next) => {
  const issue = ISSUE_PAGES.find((item) => item.slug === request.params.slug);
  if (!issue) return next();
  response.send(renderIssue(issue));
});
app.get('/freedom-plans', (_request, response) => response.send(renderPlansIndex()));
app.get('/freedom-plans/:slug', (request, response, next) => {
  const plan = PLANS.find((item) => item.slug === request.params.slug);
  if (!plan) return next();
  response.send(renderPlan(plan));
});
app.get('/volunteer', (_request, response) => response.send(renderActionPage('volunteer')));
app.get('/yard-signs', (_request, response) => response.send(renderActionPage('yard-signs')));
app.get('/friends-of-lisa', (_request, response) => response.send(renderActionPage('friends-of-lisa')));
app.get('/robots.txt', (_request, response) => {
  response.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: https://${canonicalHost}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (_request, response) => {
  const urls = ['/', ...SEO_PATHS].map((route) => `  <url><loc>https://${canonicalHost}${route}</loc></url>`).join('\n');
  response.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
});
app.get('/get-involved', (_request, response) => response.sendFile(path.join(root, 'get-involved.html')));
app.get('/', (_request, response) => response.sendFile(path.join(root, 'index.html')));
app.use((_request, response) => response.status(404).send('Not found'));
app.use((error, request, response, _next) => {
  const status = Number(error.status) >= 400 && Number(error.status) < 500 ? Number(error.status) : 500;
  console.error(`${request.method} ${request.path}: ${error.message}`);
  if (request.path.startsWith('/api/')) return response.status(status).json({ error: status === 500 ? 'Internal server error.' : error.message });
  response.status(status).send(status === 500 ? 'Internal server error' : error.message);
});

await migrate();
await bootstrapAdmin();
await pool.query('DELETE FROM admin_sessions WHERE expires_at<=now()');
app.listen(port, '0.0.0.0', () => console.info(`LB26 listening on port ${port}`));
