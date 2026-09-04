/**
 * NexusServe POS — Cloudflare Worker (Hono + Neon Postgres)
 * Drop-in API for the Pages frontend.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getSql, query, queryOne } from './db.js';
import {
  hashSecret, verifySecret, hashPins, isHashed,
  signToken, publicTenant, authRequired, requireSuperAdmin,
  requireTenantAccess, requireTenantAdmin
} from './auth.js';
import {
  normalizeBranches, ensureTenantBranches, normalizeProduct,
  getProductStockMap, getStock, setStock, applyStockDelta,
  isValidStaffRole, DEFAULT_BRANCH_DEFS, getMaxBranches
} from './data-model.js';

const app = new Hono();
app.use('*', cors());

function j(obj) {
  if (obj == null) return null;
  if (typeof obj === 'string') { try { return JSON.parse(obj); } catch { return null; } }
  return obj;
}

function mapRow(r) {
  if (!r) return null;
  const tenant = {
    id: r.id, name: r.name, code: r.code,
    username: r.username || r.code,
    password: r.password,
    businessType: r.business_type,
    tagline: r.tagline, currency: r.currency,
    themeColor: r.theme_color, accentColor: r.accent_color,
    logoUrl: r.logo_url, gstRate: Number(r.gst_rate || 0),
    b1name: r.b1name, b2name: r.b2name, b3name: r.b3name,
    pins: j(r.pins) || {},
    isOnboarded: r.is_onboarded !== false && r.is_onboarded !== 0,
    maxBranches: Number(r.max_branches ?? r.maxBranches ?? 3) || 3,
    suspended: r.is_suspended === true || r.is_suspended === 1 || r.suspended === true,
    branches: j(r.branches) || undefined,
    createdAt: r.created_at
  };
  ensureTenantBranches(tenant);
  return tenant;
}

function mapProduct(r, branches = []) {
  const stockFromCol = j(r.stock);
  const product = {
    id: r.id, name: r.name, cat: r.cat,
    price: Number(r.price), cost: Number(r.cost || 0),
    b1Stock: Number(r.b1_stock || 0),
    b2Stock: Number(r.b2_stock || 0),
    b3Stock: Number(r.b3_stock || 0),
    stock: stockFromCol || undefined,
    reorder: Number(r.reorder || 5),
    unit: r.unit || 'pcs'
  };
  return normalizeProduct(product, branches.length ? branches : normalizeBranches({}));
}

function safePub(tenant) {
  if (!tenant) return null;
  ensureTenantBranches(tenant);
  return publicTenant(tenant);
}

async function loadTenant(sql, tenantId) {
  const r = await queryOne(sql, 'SELECT * FROM tenants WHERE id = $1', [tenantId]);
  return mapRow(r);
}

/** Block staff/API use when shop is suspended (superadmin still allowed). */
async function guardActiveTenant(c) {
  const user = c.get('user');
  if (user?.role === 'superadmin') return null;
  const tenant = await loadTenant(getSql(c.env), c.req.param('tenantId'));
  if (!tenant) return c.json({ error: 'Shop not found' }, 404);
  if (tenant.suspended) {
    return c.json({ error: 'This shop is suspended. Contact your provider.', suspended: true }, 403);
  }
  return null;
}

async function persistProduct(sql, tenantId, product, branches) {
  const normalized = normalizeProduct({ ...product }, branches);
  const stock = getProductStockMap(normalized, branches.map(b => b.id));
  await query(sql, `
    INSERT INTO products (id, tenant_id, name, cat, price, cost, b1_stock, b2_stock, b3_stock, stock, reorder, unit)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, cat = EXCLUDED.cat, price = EXCLUDED.price, cost = EXCLUDED.cost,
      b1_stock = EXCLUDED.b1_stock, b2_stock = EXCLUDED.b2_stock, b3_stock = EXCLUDED.b3_stock,
      stock = EXCLUDED.stock, reorder = EXCLUDED.reorder, unit = EXCLUDED.unit
  `, [
    normalized.id, tenantId, normalized.name, normalized.cat, normalized.price, normalized.cost || 0,
    stock.b1 || 0, stock.b2 || 0, stock.b3 || 0, JSON.stringify(stock),
    normalized.reorder || 5, normalized.unit || 'pcs'
  ]);
}

const DEFAULT_SEED_ITEMS = [
  { name: 'Signature Chocolate Brownie', cat: 'Brownies', price: 95, cost: 45, b1Stock: 35, b2Stock: 20, b3Stock: 15, reorder: 10, unit: 'pcs' },
  { name: 'Red Velvet Classic Slice', cat: 'Cakes', price: 120, cost: 55, b1Stock: 20, b2Stock: 12, b3Stock: 8, reorder: 5, unit: 'pcs' },
  { name: 'Nutella Stuffed Bun', cat: 'Buns', price: 80, cost: 35, b1Stock: 25, b2Stock: 15, b3Stock: 10, reorder: 8, unit: 'pcs' },
  { name: 'Tres Leches Classic Box', cat: 'Tres Leches', price: 180, cost: 85, b1Stock: 15, b2Stock: 10, b3Stock: 5, reorder: 5, unit: 'pcs' },
  { name: 'Lotus Biscoff Cheesecake', cat: 'Cheesecake', price: 190, cost: 90, b1Stock: 18, b2Stock: 8, b3Stock: 6, reorder: 5, unit: 'pcs' },
  { name: 'Iced Caramel Macchiato', cat: 'Beverages', price: 130, cost: 40, b1Stock: 50, b2Stock: 40, b3Stock: 30, reorder: 15, unit: 'cups' }
];

async function ensureSchema(sql) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS tenants (
      id VARCHAR(100) PRIMARY KEY, name VARCHAR(255) NOT NULL, code VARCHAR(50) UNIQUE,
      username VARCHAR(100) UNIQUE, password VARCHAR(255), business_type VARCHAR(100),
      tagline TEXT, currency VARCHAR(10) DEFAULT '$', theme_color VARCHAR(50) DEFAULT '#c8860a',
      accent_color VARCHAR(50) DEFAULT '#3d1f0a', logo_url TEXT DEFAULT '', gst_rate NUMERIC DEFAULT 5,
      b1name VARCHAR(100) DEFAULT 'Branch 1', b2name VARCHAR(100) DEFAULT 'Branch 2',
      b3name VARCHAR(100) DEFAULT 'Branch 3', branches JSONB DEFAULT '[]', pins JSONB DEFAULT '{}',
      is_onboarded BOOLEAN DEFAULT true, max_branches INTEGER DEFAULT 3,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS products (
      id VARCHAR(100) PRIMARY KEY, tenant_id VARCHAR(100) REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL, cat VARCHAR(100), price NUMERIC NOT NULL, cost NUMERIC DEFAULT 0,
      b1_stock NUMERIC DEFAULT 0, b2_stock NUMERIC DEFAULT 0, b3_stock NUMERIC DEFAULT 0,
      stock JSONB DEFAULT '{}', reorder NUMERIC DEFAULT 5, unit VARCHAR(50) DEFAULT 'pcs',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS sales (
      id VARCHAR(100) PRIMARY KEY, tenant_id VARCHAR(100) REFERENCES tenants(id) ON DELETE CASCADE,
      bill_no VARCHAR(100), branch VARCHAR(50), subtotal NUMERIC, tax NUMERIC, discount NUMERIC DEFAULT 0,
      total NUMERIC, payment_method VARCHAR(50), items JSONB, customer_name VARCHAR(100),
      customer_phone VARCHAR(50), cashier VARCHAR(100), ts TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS stock_logs (
      id VARCHAR(100) PRIMARY KEY, tenant_id VARCHAR(100) REFERENCES tenants(id) ON DELETE CASCADE,
      branch VARCHAR(50), product_name VARCHAR(255), change NUMERIC, reason VARCHAR(255),
      ts TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS transfers (
      id VARCHAR(100) PRIMARY KEY, tenant_id VARCHAR(100) REFERENCES tenants(id) ON DELETE CASCADE,
      product_name VARCHAR(255), from_branch VARCHAR(50), to_branch VARCHAR(50), qty NUMERIC,
      note TEXT DEFAULT '', status VARCHAR(50) DEFAULT 'completed', ts TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    'CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id)',
    'CREATE INDEX IF NOT EXISTS idx_sales_tenant ON sales(tenant_id)',
    'ALTER TABLE tenants ADD COLUMN IF NOT EXISTS branches JSONB',
    'ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_branches INTEGER DEFAULT 3',
    'ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT false',
    // Live DBs may still have password VARCHAR(100); PBKDF2 hashes are ~111 chars
    'ALTER TABLE tenants ALTER COLUMN password TYPE VARCHAR(255)',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS stock JSONB',
    "ALTER TABLE transfers ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''"
  ];
  for (const stmt of statements) {
    try { await query(sql, stmt); } catch (e) { console.error('Schema stmt failed:', e.message || e); }
  }
}

async function seedIfEmpty(sql) {
  const count = await queryOne(sql, 'SELECT count(*)::int AS cnt FROM tenants');
  if (count && count.cnt > 0) return;

  const tenants = [
    { id: 'nb-cakes', name: 'NB Cakes & Desserts', code: 'nb', businessType: 'Bakery & Cake Shop', tagline: 'Freshly Baked Goodness & Artisan Cakes', currency: '₹', themeColor: '#c8860a', accentColor: '#3d1f0a', gstRate: 5, b1name: 'Flagship Store', b2name: 'Express Kiosk', b3name: 'Delivery Hub' },
    { id: 'urban-bites', name: 'Urban Bites & Cafe', code: 'ub', businessType: 'Cafe & Fast Food', tagline: 'Artisanal Coffee & Gourmet Street Food', currency: '$', themeColor: '#2563eb', accentColor: '#0f172a', gstRate: 8, b1name: 'Main Cafe', b2name: 'Drive Thru', b3name: 'Pop-up Cart' }
  ];

  for (const t of tenants) {
    const branches = [
      { id: 'b1', name: t.b1name, sortOrder: 0 },
      { id: 'b2', name: t.b2name, sortOrder: 1 },
      { id: 'b3', name: t.b3name, sortOrder: 2 }
    ];
    const pins = await hashPins({ admin: '1234', b1: '1111', b2: '2222', b3: '3333' });
    const pw = await hashSecret('pos123');

    await query(sql, `
      INSERT INTO tenants (id, name, code, username, password, business_type, tagline, currency, theme_color, accent_color, logo_url, gst_rate, b1name, b2name, b3name, branches, pins, is_onboarded)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'',$11,$12,$13,$14,$15::jsonb,$16::jsonb,true)
      ON CONFLICT (id) DO NOTHING
    `, [t.id, t.name, t.code, t.code, pw, t.businessType, t.tagline, t.currency, t.themeColor, t.accentColor, t.gstRate, t.b1name, t.b2name, t.b3name, JSON.stringify(branches), JSON.stringify(pins)]);

    for (let i = 0; i < DEFAULT_SEED_ITEMS.length; i++) {
      const p = DEFAULT_SEED_ITEMS[i];
      const pid = `prod_${t.code}_${i + 1}`;
      const stock = { b1: p.b1Stock, b2: p.b2Stock, b3: p.b3Stock };
      await query(sql, `
        INSERT INTO products (id, tenant_id, name, cat, price, cost, b1_stock, b2_stock, b3_stock, stock, reorder, unit)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
        ON CONFLICT (id) DO NOTHING
      `, [pid, t.id, p.name, p.cat, p.price, p.cost, p.b1Stock, p.b2Stock, p.b3Stock, JSON.stringify(stock), p.reorder, p.unit]);
    }
  }
}

// ── Routes ──

app.post('/api/superadmin/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || body.email || body.user || '').trim();
  const password = String(body.password || '');
  const superUser = c.env.SUPER_ADMIN_USER || 'admin@amtechnexus.com';
  const superPass = c.env.SUPER_ADMIN_PASSWORD || 'amtech2026';
  if (!(username === superUser || username === 'admin') || password !== superPass) {
    return c.json({ error: 'Invalid master super-admin credentials' }, 401);
  }
  const token = await signToken({ role: 'superadmin', name: 'AMtechnexus Master Control' }, c.env);
  return c.json({ success: true, role: 'superadmin', name: 'AMtechnexus Master Control', token });
});

app.post('/api/tenant/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { username, password } = body;
  if (!username || !password) return c.json({ error: 'Username and password required' }, 400);
  const u = username.trim().toLowerCase();
  const sql = getSql(c.env);
  const row = await queryOne(sql, 'SELECT * FROM tenants WHERE LOWER(username) = $1 OR LOWER(code) = $1', [u]);
  const found = mapRow(row);
  if (!found || !(await verifySecret(password.trim(), found.password))) {
    return c.json({ error: 'Invalid username or password. Contact AMtechnexus support if needed.' }, 401);
  }
  if (found.password && !isHashed(found.password)) {
    found.password = await hashSecret(password.trim());
    await query(sql, 'UPDATE tenants SET password = $1 WHERE id = $2', [found.password, found.id]);
  }
  const token = await signToken({ role: 'tenant', tenantId: found.id, staffRole: 'admin' }, c.env);
  return c.json({ success: true, token, tenant: safePub(found) });
});

app.get('/api/tenants/:tenantId/public', async (c) => {
  const tenant = await loadTenant(getSql(c.env), c.req.param('tenantId'));
  if (!tenant) return c.json({ error: 'Shop not found' }, 404);
  if (tenant.suspended) {
    return c.json({ error: 'This shop is suspended. Contact your provider.', suspended: true }, 403);
  }
  return c.json({ success: true, tenant: safePub(tenant) });
});

app.post('/api/tenants/:tenantId/verify-pin', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { role, pin } = body;
  const staffRole = String(role || '').trim();
  if (!pin || String(pin).length < 4) return c.json({ error: 'PIN required' }, 400);
  const sql = getSql(c.env);
  const tenant = await loadTenant(sql, c.req.param('tenantId'));
  if (!tenant) return c.json({ error: 'Shop not found' }, 404);
  if (tenant.suspended) {
    return c.json({ error: 'This shop is suspended. Contact your provider.', suspended: true }, 403);
  }
  if (!isValidStaffRole(tenant, staffRole)) return c.json({ error: 'Invalid role' }, 400);
  const pins = tenant.pins || {};
  const stored = pins[staffRole];
  if (!(await verifySecret(String(pin), stored))) return c.json({ error: 'Incorrect PIN' }, 401);
  if (stored && !isHashed(stored)) {
    pins[staffRole] = await hashSecret(String(pin));
    await query(sql, 'UPDATE tenants SET pins = $1::jsonb WHERE id = $2', [JSON.stringify(pins), tenant.id]);
  }
  const token = await signToken({ role: 'tenant', tenantId: tenant.id, staffRole }, c.env);
  return c.json({ success: true, token, staffRole, tenant: safePub(tenant) });
});

app.get('/api/tenants', authRequired, requireSuperAdmin, async (c) => {
  const rows = await query(getSql(c.env), 'SELECT * FROM tenants ORDER BY created_at ASC');
  return c.json({ success: true, tenants: rows.map(r => safePub(mapRow(r))) });
});

app.post('/api/tenants', authRequired, requireSuperAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { name, username, password, businessType, tagline, currency, themeColor, accentColor, logoUrl, gstRate, branches: branchInput, adminPin, isOnboarded, maxBranches: maxBranchesIn } = body;
  if (!name) return c.json({ error: 'Tenant business name is required' }, 400);

  const cleanId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').slice(0, 50) + '-' + Math.floor(1000 + Math.random() * 9000);
  const baseCode = username
    ? username.toLowerCase().replace(/[^a-z0-9_]/g, '')
    : name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  const code = `${baseCode || 'shop'}${Math.floor(100 + Math.random() * 900)}`.slice(0, 24);
  const user = username ? username.trim().toLowerCase() : code;
  const pass = password ? password.trim() : 'pos' + Math.floor(1000 + Math.random() * 9000);
  const maxBranches = getMaxBranches({ maxBranches: maxBranchesIn != null ? maxBranchesIn : 3 });

  let branchDefs = (Array.isArray(branchInput) && branchInput.length > 0)
    ? branchInput.map((b, i) => ({
        id: String(b.id || `b${i + 1}`).replace(/[^a-z0-9_]/gi, '') || `b${i + 1}`,
        name: (b.name || `Branch ${i + 1}`).trim(),
        sortOrder: i,
        pin: String(b.pin || DEFAULT_BRANCH_DEFS[Math.min(i, DEFAULT_BRANCH_DEFS.length - 1)]?.defaultPin || '1111')
      }))
    : DEFAULT_BRANCH_DEFS.map((d, i) => ({ id: d.id, name: d.name, sortOrder: i, pin: d.defaultPin }));
  branchDefs = branchDefs.slice(0, maxBranches);
  if (!branchDefs.length) branchDefs = [{ id: 'b1', name: 'Main Branch', sortOrder: 0, pin: '1111' }];

  const plainPins = { admin: adminPin || '1234' };
  for (const b of branchDefs) plainPins[b.id] = b.pin;

  const branches = branchDefs.map(({ id, name, sortOrder }) => ({ id, name, sortOrder }));
  const hashedPw = await hashSecret(pass);
  const hashedPins = await hashPins(plainPins);
  const sql = getSql(c.env);

  try {
    await query(sql, `
      INSERT INTO tenants (id, name, code, username, password, business_type, tagline, currency, theme_color, accent_color, logo_url, gst_rate, b1name, b2name, b3name, branches, pins, is_onboarded, max_branches, is_suspended)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19,false)
    `, [
      cleanId, name.trim(), code, user, hashedPw,
      businessType || 'Food & Retail', tagline || 'Quality Products & Efficient Service',
      currency || '₹', themeColor || '#e4a11b', accentColor || '#111111', logoUrl || '',
      Number(gstRate ?? 5),
      branches[0]?.name || 'Branch 1', branches[1]?.name || 'Branch 2', branches[2]?.name || 'Branch 3',
      JSON.stringify(branches), JSON.stringify(hashedPins), !!isOnboarded, maxBranches
    ]);
    // New stores start empty — products, stock, and invoices are per-tenant (no shared inventory)
  } catch (err) {
    console.error('Create tenant failed:', err?.message || err);
    // Retry without is_suspended if column missing on older DBs
    const msg = String(err?.message || err || '');
    if (msg.includes('is_suspended')) {
      try {
        await query(sql, 'ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT false');
        await query(sql, `
          INSERT INTO tenants (id, name, code, username, password, business_type, tagline, currency, theme_color, accent_color, logo_url, gst_rate, b1name, b2name, b3name, branches, pins, is_onboarded, max_branches, is_suspended)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19,false)
        `, [
          cleanId, name.trim(), code, user, hashedPw,
          businessType || 'Food & Retail', tagline || 'Quality Products & Efficient Service',
          currency || '₹', themeColor || '#e4a11b', accentColor || '#111111', logoUrl || '',
          Number(gstRate ?? 5),
          branches[0]?.name || 'Branch 1', branches[1]?.name || 'Branch 2', branches[2]?.name || 'Branch 3',
          JSON.stringify(branches), JSON.stringify(hashedPins), !!isOnboarded, maxBranches
        ]);
      } catch (err2) {
        return c.json({ error: err2?.message || 'Database insert failed' }, 500);
      }
    } else {
      return c.json({ error: msg || 'Database insert failed' }, 500);
    }
  }

  const newTenant = { id: cleanId, name: name.trim(), code, username: user, businessType: businessType || 'Food & Retail', branches, maxBranches, suspended: false };
  return c.json({
    success: true,
    tenant: safePub(newTenant),
    credentials: { username: user, password: pass, adminPin: plainPins.admin, branchPins: Object.fromEntries(branchDefs.map(b => [b.id, b.pin])) }
  });
});

app.put('/api/tenants/:tenantId', authRequired, requireTenantAccess, requireTenantAdmin, async (c) => {
  const tenantId = c.req.param('tenantId');
  const sql = getSql(c.env);
  const tenant = await loadTenant(sql, tenantId);
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404);
  const updates = await c.req.json().catch(() => ({}));
  const user = c.get('user');

  if (user?.role !== 'superadmin') {
    delete updates.maxBranches;
    delete updates.max_branches;
  } else if (updates.maxBranches != null || updates.max_branches != null) {
    updates.maxBranches = getMaxBranches({ maxBranches: updates.maxBranches ?? updates.max_branches });
    delete updates.max_branches;
  }

  if (updates.password) {
    updates.password = isHashed(updates.password) ? updates.password : await hashSecret(updates.password);
  } else {
    delete updates.password;
  }

  let newBranches = tenant.branches;
  if (Array.isArray(updates.branches)) {
    newBranches = updates.branches.map((b, i) => ({
      id: String(b.id || `b${i + 1}`).replace(/[^a-z0-9_]/gi, '') || `b${i + 1}`,
      name: (b.name || `Branch ${i + 1}`).trim(),
      sortOrder: b.sortOrder != null ? Number(b.sortOrder) : i
    }));
    const maxAllowed = getMaxBranches({
      maxBranches: updates.maxBranches != null ? updates.maxBranches : tenant.maxBranches
    });
    if (newBranches.length > maxAllowed) {
      return c.json({
        error: `This business is limited to ${maxAllowed} branch${maxAllowed === 1 ? '' : 'es'}. Contact your provider to raise the limit.`
      }, 400);
    }
  }

  let newPins = tenant.pins;
  if (updates.pinPlaintext && typeof updates.pinPlaintext === 'object') {
    const merged = { ...newPins };
    for (const [role, plain] of Object.entries(updates.pinPlaintext)) {
      if (plain == null || String(plain).trim() === '') continue;
      merged[role] = await hashSecret(String(plain).trim());
    }
    newPins = merged;
  } else if (updates.pins && typeof updates.pins === 'object') {
    newPins = await hashPins(updates.pins);
  }

  await query(sql, `
    UPDATE tenants SET
      name = COALESCE($1, name), business_type = COALESCE($2, business_type),
      tagline = COALESCE($3, tagline), currency = COALESCE($4, currency),
      theme_color = COALESCE($5, theme_color), accent_color = COALESCE($6, accent_color),
      logo_url = COALESCE($7, logo_url), gst_rate = COALESCE($8, gst_rate),
      b1name = COALESCE($9, b1name), b2name = COALESCE($10, b2name), b3name = COALESCE($11, b3name),
      branches = $12::jsonb, pins = $13::jsonb,
      username = COALESCE($14, username), password = COALESCE($15, password),
      is_onboarded = COALESCE($16, is_onboarded),
      max_branches = COALESCE($17, max_branches)
    WHERE id = $18
  `, [
    updates.name || null, updates.businessType || null, updates.tagline || null,
    updates.currency || null, updates.themeColor || null, updates.accentColor || null,
    updates.logoUrl || null, updates.gstRate != null ? Number(updates.gstRate) : null,
    newBranches[0]?.name || null, newBranches[1]?.name || null, newBranches[2]?.name || null,
    JSON.stringify(newBranches), JSON.stringify(newPins),
    updates.username || null, updates.password || null,
    updates.isOnboarded != null ? !!updates.isOnboarded : null,
    updates.maxBranches != null ? updates.maxBranches : null,
    tenantId
  ]);

  return c.json({ success: true, tenant: safePub(await loadTenant(sql, tenantId)) });
});

app.delete('/api/tenants/:tenantId', authRequired, requireSuperAdmin, async (c) => {
  const tenantId = c.req.param('tenantId');
  const sql = getSql(c.env);
  const existing = await loadTenant(sql, tenantId);
  if (!existing) return c.json({ error: 'Shop not found' }, 404);
  await query(sql, 'DELETE FROM tenants WHERE id = $1', [tenantId]);
  return c.json({ success: true });
});

app.post('/api/tenants/:tenantId/status', authRequired, requireSuperAdmin, async (c) => {
  const tenantId = c.req.param('tenantId');
  const body = await c.req.json().catch(() => ({}));
  const suspended = !!body.suspended;
  const sql = getSql(c.env);
  const existing = await loadTenant(sql, tenantId);
  if (!existing) return c.json({ error: 'Shop not found' }, 404);
  await query(sql, 'UPDATE tenants SET is_suspended = $1 WHERE id = $2', [suspended, tenantId]);
  const tenant = await loadTenant(sql, tenantId);
  return c.json({ success: true, tenant: safePub(tenant) });
});

app.get('/api/tenant/:tenantId/data', authRequired, requireTenantAccess, async (c) => {
  const tenantId = c.req.param('tenantId');
  const sql = getSql(c.env);
  const tenant = await loadTenant(sql, tenantId);
  if (!tenant) return c.json({ error: 'Client tenant not found' }, 404);
  const user = c.get('user');
  if (tenant.suspended && user?.role !== 'superadmin') {
    return c.json({ error: 'This shop is suspended. Contact your provider.', suspended: true }, 403);
  }
  const branches = tenant.branches;

  const prodRows = await query(sql, 'SELECT * FROM products WHERE tenant_id = $1 ORDER BY name ASC', [tenantId]);
  const products = prodRows.map(r => mapProduct(r, branches));

  const saleRows = await query(sql, 'SELECT * FROM sales WHERE tenant_id = $1 ORDER BY ts DESC LIMIT 500', [tenantId]);
  const sales = saleRows.map(r => ({
    id: r.id, billNo: r.bill_no, branch: r.branch,
    subtotal: Number(r.subtotal), tax: Number(r.tax), discount: Number(r.discount || 0),
    total: Number(r.total), payMethod: r.payment_method,
    items: j(r.items), customerName: r.customer_name, customerPhone: r.customer_phone,
    custName: r.customer_name, custPhone: r.customer_phone,
    cashier: r.cashier, ts: r.ts
  }));

  const logRows = await query(sql, 'SELECT * FROM stock_logs WHERE tenant_id = $1 ORDER BY ts DESC LIMIT 500', [tenantId]);
  const stockLogs = logRows.map(r => ({
    id: r.id, branch: r.branch, productName: r.product_name,
    change: Number(r.change), reason: r.reason, ts: r.ts
  }));

  const trRows = await query(sql, 'SELECT * FROM transfers WHERE tenant_id = $1 ORDER BY ts DESC LIMIT 500', [tenantId]);
  const transfers = trRows.map(r => ({
    id: r.id, productName: r.product_name,
    fromBranch: r.from_branch, toBranch: r.to_branch,
    qty: Number(r.qty), note: r.note, ts: r.ts
  }));

  return c.json({ success: true, tenant: safePub(tenant), branches, products, sales, stockLogs, transfers });
});

app.post('/api/tenant/:tenantId/products', authRequired, requireTenantAccess, requireTenantAdmin, async (c) => {
  const blocked = await guardActiveTenant(c);
  if (blocked) return blocked;
  const tenantId = c.req.param('tenantId');
  const sql = getSql(c.env);
  const tenant = await loadTenant(sql, tenantId);
  const branches = tenant ? tenant.branches : normalizeBranches({});
  const body = await c.req.json().catch(() => ({}));
  const newId = body.id || `prod_${crypto.randomUUID().slice(0, 8)}`;
  const stock = body.stock && typeof body.stock === 'object' ? body.stock : getProductStockMap(body, branches.map(b => b.id));
  const item = normalizeProduct({ ...body, id: newId, stock }, branches);
  await persistProduct(sql, tenantId, item, branches);
  return c.json({ success: true, product: item });
});

app.put('/api/tenant/:tenantId/products/:id', authRequired, requireTenantAccess, requireTenantAdmin, async (c) => {
  const blocked = await guardActiveTenant(c);
  if (blocked) return blocked;
  const tenantId = c.req.param('tenantId');
  const id = c.req.param('id');
  const sql = getSql(c.env);
  const tenant = await loadTenant(sql, tenantId);
  const branches = tenant ? tenant.branches : normalizeBranches({});
  const updates = await c.req.json().catch(() => ({}));

  const existing = await queryOne(sql, 'SELECT * FROM products WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  const current = existing ? mapProduct(existing, branches) : { id };
  const merged = normalizeProduct({ ...current, ...updates, id }, branches);
  if (updates.stock) { for (const [bid, qty] of Object.entries(updates.stock)) setStock(merged, bid, qty); }
  for (const b of branches) {
    const lk = b.id + 'Stock';
    if (updates[lk] != null) setStock(merged, b.id, updates[lk]);
  }
  await persistProduct(sql, tenantId, merged, branches);
  return c.json({ success: true, product: merged });
});

app.delete('/api/tenant/:tenantId/products/:id', authRequired, requireTenantAccess, requireTenantAdmin, async (c) => {
  const blocked = await guardActiveTenant(c);
  if (blocked) return blocked;
  await query(getSql(c.env), 'DELETE FROM products WHERE tenant_id = $1 AND id = $2', [c.req.param('tenantId'), c.req.param('id')]);
  return c.json({ success: true });
});

app.post('/api/tenant/:tenantId/sales', authRequired, requireTenantAccess, async (c) => {
  const blocked = await guardActiveTenant(c);
  if (blocked) return blocked;
  const tenantId = c.req.param('tenantId');
  const sql = getSql(c.env);
  const sale = await c.req.json().catch(() => ({}));
  const tenant = await loadTenant(sql, tenantId);
  const branches = tenant ? tenant.branches : normalizeBranches({});
  const saleId = sale.id || `sale_${Date.now()}`;
  let branchId = sale.branch || (branches[0]?.id) || 'b1';

  const user = c.get('user');
  const staffRole = user?.staffRole;
  if (user?.role === 'tenant' && staffRole && staffRole !== 'admin') {
    if (sale.branch && sale.branch !== staffRole) {
      return c.json({ error: 'Cashiers can only sell from their own store' }, 403);
    }
    branchId = staffRole;
  }

  const newSale = {
    ...sale, id: saleId, branch: branchId,
    customerName: sale.customerName || sale.custName || '',
    customerPhone: sale.customerPhone || sale.custPhone || '',
    payMethod: sale.payMethod || sale.paymentMethod || 'cash',
    cashier: sale.cashier || staffRole || 'admin',
    ts: new Date().toISOString()
  };

  await query(sql, `
    INSERT INTO sales (id, tenant_id, bill_no, branch, subtotal, tax, discount, total, payment_method, items, customer_name, customer_phone, cashier, ts)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)
    ON CONFLICT (id) DO NOTHING
  `, [
    saleId, tenantId, newSale.billNo || null, newSale.branch,
    newSale.subtotal || 0, newSale.tax || 0, newSale.discount || 0, newSale.total || 0,
    newSale.payMethod, JSON.stringify(newSale.items || []),
    newSale.customerName, newSale.customerPhone, newSale.cashier, newSale.ts
  ]);

  const touched = [];
  if (Array.isArray(newSale.items)) {
    for (const cartItem of newSale.items) {
      const pid = cartItem.id || cartItem.productId;
      const row = await queryOne(sql, 'SELECT * FROM products WHERE tenant_id = $1 AND id = $2', [tenantId, pid]);
      if (row) {
        const prod = mapProduct(row, branches);
        applyStockDelta(prod, branchId, -(cartItem.qty || 1));
        normalizeProduct(prod, branches);
        await persistProduct(sql, tenantId, prod, branches);
        touched.push(prod);
      }
    }
  }
  return c.json({ success: true, sale: newSale, products: touched });
});

app.post('/api/tenant/:tenantId/stock-log', authRequired, requireTenantAccess, requireTenantAdmin, async (c) => {
  const blocked = await guardActiveTenant(c);
  if (blocked) return blocked;
  const tenantId = c.req.param('tenantId');
  const body = await c.req.json().catch(() => ({}));
  const log = { id: `log_${Date.now()}`, ...body, ts: new Date().toISOString() };
  await query(getSql(c.env), `
    INSERT INTO stock_logs (id, tenant_id, branch, product_name, change, reason, ts)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING
  `, [log.id, tenantId, log.branch || null, log.productName || log.product_name || '', log.change || 0, log.reason || '', log.ts]);
  return c.json({ success: true, log });
});

app.post('/api/tenant/:tenantId/transfers', authRequired, requireTenantAccess, requireTenantAdmin, async (c) => {
  const blocked = await guardActiveTenant(c);
  if (blocked) return blocked;
  const tenantId = c.req.param('tenantId');
  const sql = getSql(c.env);
  const body = await c.req.json().catch(() => ({}));
  const tenant = await loadTenant(sql, tenantId);
  const branches = tenant ? tenant.branches : normalizeBranches({});
  const fromBranch = body.fromBranch || body.from;
  const toBranch = body.toBranch || body.to;
  const qty = Number(body.qty || 0);
  const productId = body.productId || body.itemId;

  if (!fromBranch || !toBranch || fromBranch === toBranch) return c.json({ error: 'fromBranch and toBranch must differ' }, 400);
  if (!productId || qty <= 0) return c.json({ error: 'productId and positive qty required' }, 400);

  const row = await queryOne(sql, 'SELECT * FROM products WHERE tenant_id = $1 AND id = $2', [tenantId, productId]);
  if (!row) return c.json({ error: 'Product not found' }, 404);
  const prod = mapProduct(row, branches);

  const available = getStock(prod, fromBranch);
  if (available < qty) return c.json({ error: `Insufficient stock at source (have ${available})` }, 400);

  applyStockDelta(prod, fromBranch, -qty);
  applyStockDelta(prod, toBranch, qty);
  normalizeProduct(prod, branches);
  await persistProduct(sql, tenantId, prod, branches);

  const transfer = {
    id: `tr_${Date.now()}`, productId: prod.id, productName: prod.name,
    fromBranch, toBranch, qty, note: body.note || '', ts: new Date().toISOString()
  };
  await query(sql, `
    INSERT INTO transfers (id, tenant_id, product_name, from_branch, to_branch, qty, note, ts)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING
  `, [transfer.id, tenantId, transfer.productName, transfer.fromBranch, transfer.toBranch, transfer.qty, transfer.note, transfer.ts]);

  return c.json({ success: true, transfer, product: prod });
});

app.get('/api/db-status', async (c) => {
  try {
    const sql = getSql(c.env);
    const row = await queryOne(sql, 'SELECT count(*)::int AS cnt FROM tenants');
    return c.json({
      isPostgresConnected: true,
      databaseUrlSet: !!c.env.DATABASE_URL,
      storageType: 'Neon PostgreSQL',
      totalTenants: row?.cnt ?? 0
    });
  } catch (e) {
    return c.json({
      isPostgresConnected: false,
      databaseUrlSet: !!c.env.DATABASE_URL,
      storageType: 'Neon PostgreSQL (unreachable)',
      error: String(e.message || e)
    }, 503);
  }
});

app.get('/api/health', (c) => c.json({ ok: true, runtime: 'cloudflare-workers', db: 'neon' }));

let bootstrapped = false;

export default {
  async fetch(request, env, ctx) {
    if (!bootstrapped && env.DATABASE_URL) {
      try {
        const sql = getSql(env);
        await ensureSchema(sql);
        await seedIfEmpty(sql);
        bootstrapped = true;
      } catch (e) {
        console.error('Bootstrap error:', e);
      }
    }
    return app.fetch(request, env, ctx);
  }
};
