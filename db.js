import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const root = path.dirname(fileURLToPath(import.meta.url));
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DATABASE_POOL_SIZE || 10) });

export function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [algorithm, saltHex, hashHex] = String(stored).split(':');
  if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function digestToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await fs.readdir(path.join(root, 'migrations'))).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files) {
      const found = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
      if (found.rowCount) continue;
      await client.query(await fs.readFile(path.join(root, 'migrations', file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function bootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required');
  if (password.length < 14) throw new Error('ADMIN_PASSWORD must be at least 14 characters');
  if ((await pool.query('SELECT id FROM admin_users LIMIT 1')).rowCount) return;
  await pool.query('INSERT INTO admin_users (email, password_hash, role) VALUES ($1, $2, $3)', [email, hashPassword(password), 'admin']);
  console.info(`Created initial admin user: ${email}`);
}
