import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const AUTH_SECRET = process.env.AUTH_SECRET || 'dev-only-change-me-nexusserve';
const TOKEN_TTL = process.env.AUTH_TOKEN_TTL || '12h';
const BCRYPT_ROUNDS = 10;

if (!process.env.AUTH_SECRET) {
  console.warn('[auth] AUTH_SECRET is not set — using an insecure development default. Set AUTH_SECRET in .env for production.');
}

export function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$/.test(value);
}

export async function hashSecret(plain) {
  return bcrypt.hash(String(plain), BCRYPT_ROUNDS);
}

export async function verifySecret(plain, stored) {
  if (stored == null || plain == null) return false;
  if (isBcryptHash(stored)) {
    return bcrypt.compare(String(plain), stored);
  }
  // Legacy plaintext fallback (migrated to hash on successful login)
  return String(plain) === String(stored);
}

export async function hashPins(pins = {}) {
  const out = {};
  for (const [role, value] of Object.entries(pins)) {
    if (value == null || value === '') continue;
    out[role] = isBcryptHash(value) ? value : await hashSecret(value);
  }
  return out;
}

export function signToken(payload) {
  return jwt.sign(payload, AUTH_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token) {
  return jwt.verify(token, AUTH_SECRET);
}

/** Strip secrets before sending tenant objects to the browser */
export function publicTenant(tenant) {
  if (!tenant) return null;
  const { password, pins, ...safe } = tenant;
  return safe;
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = verifyToken(token);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required' });
  }
  return next();
}

/** Superadmin or a session issued for this tenant */
export function requireTenantAccess(req, res, next) {
  const { tenantId } = req.params;
  if (req.user?.role === 'superadmin') return next();
  if (req.user?.role === 'tenant' && req.user?.tenantId === tenantId) return next();
  return res.status(403).json({ error: 'Access denied for this workspace' });
}

/** Superadmin or tenant admin staff role */
export function requireTenantAdmin(req, res, next) {
  if (req.user?.role === 'superadmin') return next();
  if (req.user?.role === 'tenant' && req.user?.tenantId === req.params.tenantId && req.user?.staffRole === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Admin role required' });
}
