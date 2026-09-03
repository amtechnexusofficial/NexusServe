/**
 * Auth utilities for Cloudflare Workers.
 * Uses Web Crypto (PBKDF2) instead of bcryptjs, and jose instead of jsonwebtoken.
 */
import { SignJWT, jwtVerify } from 'jose';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function getSecret(env) {
  return new TextEncoder().encode(env.AUTH_SECRET || 'dev-only-change-me-nexusserve');
}

// ── Password hashing (PBKDF2-SHA256) ──

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

export function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$/.test(value);
}

function isPbkdf2Hash(value) {
  return typeof value === 'string' && value.startsWith('pbkdf2:');
}

export function isHashed(value) {
  return isBcryptHash(value) || isPbkdf2Hash(value);
}

export async function hashSecret(plain) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(plain)), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    HASH_BYTES * 8
  );
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toHex(salt)}:${toHex(derived)}`;
}

export async function verifySecret(plain, stored) {
  if (stored == null || plain == null) return false;

  if (isPbkdf2Hash(stored)) {
    const [, iterStr, saltHex, hashHex] = stored.split(':');
    const iterations = parseInt(iterStr, 10);
    const salt = fromHex(saltHex);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(plain)), 'PBKDF2', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      key,
      HASH_BYTES * 8
    );
    return toHex(derived) === hashHex;
  }

  // Legacy bcrypt hashes can't be verified in Workers — treat as plaintext comparison
  // (on first successful login the hash will be migrated to PBKDF2)
  if (isBcryptHash(stored)) {
    return false; // Can't verify bcrypt on edge; force PIN reset or migration
  }

  // Legacy plaintext fallback
  return String(plain) === String(stored);
}

export async function hashPins(pins = {}) {
  const out = {};
  for (const [role, value] of Object.entries(pins)) {
    if (value == null || value === '') continue;
    out[role] = isHashed(value) ? value : await hashSecret(value);
  }
  return out;
}

// ── JWT ──

export async function signToken(payload, env) {
  const secret = getSecret(env);
  const ttl = env.AUTH_TOKEN_TTL || '12h';
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret);
}

export async function verifyToken(token, env) {
  const secret = getSecret(env);
  const { payload } = await jwtVerify(token, secret);
  return payload;
}

// ── Middleware helpers (Hono-style) ──

export function publicTenant(tenant) {
  if (!tenant) return null;
  const { password, pins, ...safe } = tenant;
  return safe;
}

export async function authRequired(c, next) {
  const header = c.req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return c.json({ error: 'Authentication required' }, 401);
  try {
    c.set('user', await verifyToken(token, c.env));
    return next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
}

export async function requireSuperAdmin(c, next) {
  if (c.get('user')?.role !== 'superadmin') {
    return c.json({ error: 'Superadmin access required' }, 403);
  }
  return next();
}

export async function requireTenantAccess(c, next) {
  const tenantId = c.req.param('tenantId');
  const user = c.get('user');
  if (user?.role === 'superadmin') return next();
  if (user?.role === 'tenant' && user?.tenantId === tenantId) return next();
  return c.json({ error: 'Access denied for this workspace' }, 403);
}

export async function requireTenantAdmin(c, next) {
  const user = c.get('user');
  if (user?.role === 'superadmin') return next();
  if (user?.role === 'tenant' && user?.tenantId === c.req.param('tenantId') && user?.staffRole === 'admin') {
    return next();
  }
  return c.json({ error: 'Admin role required' }, 403);
}
