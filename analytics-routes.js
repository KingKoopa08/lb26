import crypto from 'node:crypto';

const attempts = new Map();
const clean = (value, max = 500) => String(value || '').trim().slice(0, max);
const digest = (value) => crypto.createHash('sha256').update(`${process.env.ANALYTICS_SALT || 'lb26-analytics'}:${value}`).digest('hex');

function allowed(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((at) => now - at < 3600000);
  attempts.set(ip, recent);
  return recent.length < 600;
}

function clientInfo(userAgent = '') {
  const ua = String(userAgent);
  const device = /bot|crawler|spider|preview/i.test(ua) ? 'bot' : /ipad|tablet/i.test(ua) ? 'tablet' : /mobile|android|iphone/i.test(ua) ? 'mobile' : 'desktop';
  const browser = /edg\//i.test(ua) ? 'Edge' : /firefox\//i.test(ua) ? 'Firefox' : /chrome\//i.test(ua) ? 'Chrome' : /safari\//i.test(ua) ? 'Safari' : 'Other';
  const os = /iphone|ipad|ios/i.test(ua) ? 'iOS' : /android/i.test(ua) ? 'Android' : /windows/i.test(ua) ? 'Windows' : /mac os|macintosh/i.test(ua) ? 'macOS' : /linux/i.test(ua) ? 'Linux' : 'Other';
  return { device, browser, os };
}

function attribution(body) {
  const utmSource = clean(body.utmSource, 120);
  if (utmSource) return { source:utmSource, medium:clean(body.utmMedium,120)||null };
  try {
    const host = new URL(clean(body.referrer, 1000)).hostname.replace(/^www\./, '');
    if (/google\.|bing\.|yahoo\.|duckduckgo\./i.test(host)) return { source:host.split('.')[0], medium:'organic' };
    if (/facebook\.|instagram\.|threads\.|twitter\.|x\.com$|t\.co$|youtube\.|reddit\.|linkedin\./i.test(host)) return { source:host, medium:'social' };
    return host ? { source:host, medium:'referral' } : { source:'Direct', medium:null };
  } catch { return { source:'Direct', medium:null }; }
}

const rangeDays = (value) => [7,30,90,365].includes(Number(value)) ? Number(value) : 30;

export function registerAnalyticsRoutes(app, { pool, requireAdmin, readSession }) {
  app.post('/api/public/analytics', async (request, response, next) => {
    try {
      if (await readSession(request) || !allowed(request.ip)) return response.status(204).end();
      attempts.set(request.ip, [...(attempts.get(request.ip) || []), Date.now()]);
      const body = request.body || {};
      if (!['page_view','conversion'].includes(body.eventType) || !clean(body.visitorId,100) || !clean(body.sessionId,100)) return response.status(204).end();
      const info = clientInfo(request.get('user-agent'));
      const pagePath = clean(body.path,500).split('?')[0];
      if (info.device === 'bot' || !pagePath.startsWith('/') || pagePath.startsWith('/admin')) return response.status(204).end();
      const attr = attribution(body);
      const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? Object.fromEntries(Object.entries(body.metadata).slice(0,10).map(([k,v])=>[clean(k,50),clean(v,200)])) : {};
      await pool.query(`INSERT INTO web_analytics_events (event_type,event_name,visitor_id,session_id,page_path,page_title,referrer,source,medium,campaign,term,content,device_type,browser,operating_system,country_code,region,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[
        body.eventType,clean(body.eventName,80)||null,digest(clean(body.visitorId,100)),digest(clean(body.sessionId,100)),pagePath,clean(body.title,300)||null,clean(body.referrer,1000)||null,attr.source,attr.medium,clean(body.utmCampaign,160)||null,clean(body.utmTerm,160)||null,clean(body.utmContent,160)||null,info.device,info.browser,info.os,clean(request.get('cf-ipcountry'),2).toUpperCase()||null,clean(request.get('cf-region'),120)||null,JSON.stringify(metadata)
      ]);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.get('/api/admin/analytics', requireAdmin, async (request, response, next) => {
    try {
      const days = rangeDays(request.query.days);
      const values = [days];
      const since = `occurred_at >= now() - ($1::int * interval '1 day')`;
      const [summary,trend,sources,pages,campaigns,devices,browsers,countries,conversions] = await Promise.all([
        pool.query(`WITH e AS (SELECT * FROM web_analytics_events WHERE ${since}),s AS (SELECT session_id,count(*) FILTER (WHERE event_type='page_view') views FROM e GROUP BY session_id) SELECT count(*) FILTER (WHERE event_type='page_view')::int page_views,count(DISTINCT visitor_id)::int visitors,count(DISTINCT session_id)::int sessions,count(*) FILTER (WHERE event_type='conversion')::int conversions,COALESCE(round((SELECT avg(views) FROM s),2),0) pages_per_session,COALESCE(round(100.0*(SELECT count(*) FROM s WHERE views=1)/NULLIF((SELECT count(*) FROM s),0),1),0) bounce_rate FROM e`,values),
        pool.query(`SELECT to_char(calendar.day,'YYYY-MM-DD') AS "day",COALESCE(page_views,0)::int AS page_views,COALESCE(visitors,0)::int AS visitors FROM generate_series(current_date-($1::int-1),current_date,interval '1 day') AS calendar(day) LEFT JOIN (SELECT date_trunc('day',occurred_at) AS bucket,count(*) FILTER (WHERE event_type='page_view') AS page_views,count(DISTINCT visitor_id) AS visitors FROM web_analytics_events WHERE ${since} GROUP BY 1) x ON x.bucket=calendar.day ORDER BY calendar.day`,values),
        pool.query(`SELECT source,COALESCE(medium,'none') medium,count(DISTINCT session_id)::int sessions,count(DISTINCT visitor_id)::int visitors FROM web_analytics_events WHERE ${since} GROUP BY source,medium ORDER BY sessions DESC LIMIT 15`,values),
        pool.query(`SELECT page_path,count(*)::int views,count(DISTINCT visitor_id)::int visitors FROM web_analytics_events WHERE ${since} AND event_type='page_view' GROUP BY page_path ORDER BY views DESC LIMIT 20`,values),
        pool.query(`SELECT campaign,source,count(DISTINCT session_id)::int sessions,count(*) FILTER (WHERE event_type='conversion')::int conversions FROM web_analytics_events WHERE ${since} AND campaign IS NOT NULL GROUP BY campaign,source ORDER BY sessions DESC LIMIT 15`,values),
        pool.query(`SELECT COALESCE(device_type,'Unknown') label,count(DISTINCT session_id)::int value FROM web_analytics_events WHERE ${since} GROUP BY device_type ORDER BY value DESC`,values),
        pool.query(`SELECT COALESCE(browser,'Unknown') label,count(DISTINCT session_id)::int value FROM web_analytics_events WHERE ${since} GROUP BY browser ORDER BY value DESC`,values),
        pool.query(`SELECT COALESCE(country_code,'Unknown') label,count(DISTINCT session_id)::int value FROM web_analytics_events WHERE ${since} GROUP BY country_code ORDER BY value DESC LIMIT 15`,values),
        pool.query(`SELECT COALESCE(event_name,'Other') event_name,count(*)::int count FROM web_analytics_events WHERE ${since} AND event_type='conversion' GROUP BY event_name ORDER BY count DESC`,values),
      ]);
      response.json({days,summary:summary.rows[0],trend:trend.rows,sources:sources.rows,pages:pages.rows,campaigns:campaigns.rows,devices:devices.rows,browsers:browsers.rows,countries:countries.rows,conversions:conversions.rows});
    } catch (error) { next(error); }
  });
}
