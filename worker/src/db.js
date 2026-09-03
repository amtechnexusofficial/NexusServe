/**
 * Neon Postgres client for Cloudflare Workers.
 * Uses @neondatabase/serverless HTTP driver (no TCP / node-pg).
 */
import { neon } from '@neondatabase/serverless';

export function getSql(env) {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Add it with: wrangler secret put DATABASE_URL');
  }
  return neon(url);
}

/** Run a parameterized query with $1, $2… placeholders. Returns rows array. */
export async function query(sql, text, params = []) {
  // neon() supports: sql(queryString, params) → rows[]
  return sql(text, params);
}

export async function queryOne(sql, text, params = []) {
  const rows = await query(sql, text, params);
  return rows[0] || null;
}
