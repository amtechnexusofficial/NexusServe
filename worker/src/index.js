/**
 * NexusServe POS — Cloudflare Worker (Hono + D1)
 * Drop-in replacement for server.js Express backend.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  hashSecret, verifySecret, hashPins, isHashed, isBcryptHash,
  signToken, publicTenant, authRequired, requireSuperAdmin,
  requireTenantAccess, requireTenantAdmin
} from './auth.js';
import {
  normalizeBranches, ensureTenantBranches, normalizeProduct,
  getProductStockMap, getStock, setStock, applyStockDelta,
  isValidStaffRole, DEFAULT_BRANCH_DEFS
} from './data-model.js';

const app = new Hono();
app.use('*', cors());

// ── Helpers ──

function j(obj, key) {
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
    isOnboarded: r.is_onboarded === 1 || r.is_onboarded === true,
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

async function loadTenant(db, tenantId) {
  const r = await db.prepare('SELECT * FROM tenants WHERE id = ?').bind(tenantId).first();
  return mapRow(r);
}

function getBranches(db, tenantId, tenant) {
  return ensureTenantBranches(tenant);
}

async function persistProduct(db, tenantId, product, branches) {
  const normalized = normalizeProduct({ ...product }, branches);
  const stock = getProductStockMap(normalized, branches.map(b => b.id));
  await db.prepare(`
    INSERT INTO products (id, tenant_id, name, cat, price, cost, b1_stock, b2_stock, b3_stock, stock, reorder, unit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name, cat = excluded.cat, price = excluded.price, cost = excluded.cost,
      b1_stock = excluded.b1_stock, b2_stock = excluded.b2_stock, b3_stock = excluded.b3_stock,
      stock = excluded.stock, reorder = excluded.reorder, unit = excluded.unit
  `).bind(
    normalized.id, tenantId, normalized.name, normalized.cat, normalized.price, normalized.cost || 0,
    stock.b1 || 0, stock.b2 || 0, stock.b3 || 0, JSON.stringify(stock),
    normalized.reorder || 5, normalized.unit || 'pcs'
  ).run();
}

// ── Default seed data ──

const DEFAULT_SEED_ITEMS = [
  { name: 'Signature Chocolate Brownie', cat: 'Brownies', price: 95, cost: 45, b1Stock: 35, b2Stock: 20, b3Stock: 15, reorder: 10, unit: 'pcs' },
  { name: 'Red Velvet Classic Slice', cat: 'Cakes', price: 120, cost: 55, b1Stock: 20, b2Stock: 12, b3Stock: 8, reorder: 5, unit: 'pcs' },
  { name: 'Nutella Stuffed Bun', cat: 'Buns', price: 80, cost: 35, b1Stock: 25, b2Stock: 15, b3Stock: 10, reorder: 8, unit: 'pcs' },
  { name: 'Tres Leches Classic Box', cat: 'Tres Leches', price: 180, cost: 85, b1Stock: 15, b2Stock: 10, b3Stock: 5, reorder: 5, unit: 'pcs' },
  { name: 'Lotus Biscoff Cheesecake', cat: 'Cheesecake', price: 190, cost: 90, b1Stock: 18, b2Stock: 8, b3Stock: 6, reorder: 5, unit: 'pcs' },
  { name: 'Iced Caramel Macchiato', cat: 'Beverages', price: 130, cost: 40, b1Stock: 50, b2Stock: 40, b3Stock: 30, reorder: 15, unit: 'cups' }
];

async function seedIfEmpty(db) {
  const count = await db.prepare('SELECT count(*) as cnt FROM tenants').first();
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

    await db.prepare(`
      INSERT INTO tenants (id, name, code, username, password, business_type, tagline, currency, theme_color, accent_color, logo_url, gst_rate, b1name, b2name, b3name, branches, pins, is_onboarded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, 1)
    `).bind(t.id, t.name, t.code, t.code, pw, t.businessType, t.tagline, t.currency, t.themeColor, t.accentColor, t.gstRate, t.b1name, t.b2name, t.b3name, JSON.stringify(branches), JSON.stringify(pins)).run();

    for (let i = 0; i < DEFAULT_SEED_ITEMS.length; i++) {
      const p = DEFAULT_SEED_ITEMS[i];
      const pid = `prod_${t.code}_${i + 1}`;
      const stock = { b1: p.b1Stock, b2: p.b2Stock, b3: p.b3Stock };
      await db.prepare(`
        INSERT INTO products (id, tenant_id, name, cat, price, cost, b1_stock, b2_stock, b3_stock, stock, reorder, unit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(pid, t.id, p.name, p.cat, p.price, p.cost, p.b1Stock, p.b2Stock, p.b3Stock, JSON.stringify(stock), p.reorder, p.unit).run();
    }
  }
}

// ── Routes ──

// Super-Admin Login
app.post('/api/superadmin/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || body.email || body.user || '').trim();
  const password = String(body.password || '');
  const superUser = c.env.SUPER_ADMIN_USER || 'admin@amtechnexus.com';
  const superPass = c.env.SUPER_ADMIN_PASSWORD || 'amtech2026';
  const userOk = username === superUser || username === 'admin';
  const passOk = password === superPass;
  if (!userOk || !passOk) return c.json({ error: 'Invalid master super-admin credentials' }, 401);
  const token = await signToken({ role: 'superadmin', name: 'AMtechnexus Master Control' }, c.env);
  return c.json({ success: true, role: 'superadmin', name: 'AMtechnexus Master Control', token });
});

// Tenant Login
app.post('/api/tenant/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { username, password } = body;
  if (!username || !password) return c.json({ error: 'Username and password required' }, 400);
  const u = username.trim().toLowerCase();
  const db = c.env.DB;
  const row = await db.prepare('SELECT * FROM tenants WHERE LOWER(username) = ? OR LOWER(code) = ?').bind(u, u).first();
  const found = mapRow(row);
  if (!found || !(await verifySecret(password.trim(), found.password))) {
    return c.json({ error: 'Invalid username or password. Contact AMtechnexus support if needed.' }, 401);
  }
  if (found.password && !isHashed(found.password)) {
    found.password = await hashSecret(password.trim());
    await db.prepare('UPDATE tenants SET password = ? WHERE id = ?').bind(found.password, found.id).run();
  }
  const token = await signToken({ role: 'tenant', tenantId: found.id, staffRole: 'admin' }, c.env);
  return c.json({ success: true, token, tenant: safePub(found) });
});

// Public shop profile
app.get('/api/tenants/:tenantId/public', async (c) => {
  const tenant = await loadTenant(c.env.DB, c.req.param('tenantId'));
  if (!tenant) return c.json({ error: 'Shop not found' }, 404);
  return c.json({ success: true, tenant: safePub(tenant) });
});

// PIN verify
app.post('/api/tenants/:tenantId/verify-pin', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { role, pin } = body;
  const staffRole = String(role || '').trim();
  if (!pin || String(pin).length < 4) return c.json({ error: 'PIN required' }, 400);
  const db = c.env.DB;
  const tenant = await loadTenant(db, c.req.param('tenantId'));
  if (!tenant) return c.json({ error: 'Shop not found' }, 404);
  if (!isValidStaffRole(tenant, staffRole)) return c.json({ error: 'Invalid role' }, 400);
  const pins = tenant.pins || {};
  const stored = pins[staffRole];
  if (!(await verifySecret(String(pin), stored))) return c.json({ error: 'Incorrect PIN' }, 401);
  if (stored && !isHashed(stored)) {
    pins[staffRole] = await hashSecret(String(pin));
    tenant.pins = pins;
    await db.prepare('UPDATE tenants SET pins = ? WHERE id = ?').bind(JSON.stringify(pins), tenant.id).run();
  }
  const token = await signToken({ role: 'tenant', tenantId: tenant.id, staffRole }, c.env);
  return c.json({ success: true, token, staffRole, tenant: safePub(tenant) });
});

// List tenants (superadmin)
app.get('/api/tenants', authRequired, requireSuperAdmin, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM tenants ORDER BY created_at ASC').all();
  return c.json({ success: true, tenants: results.map(r => safePub(mapRow(r))) });
});

// Create tenant (superadmin)
app.post('/api/tenants', authRequired, requireSuperAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { name, username, password, businessType, tagline, currency, themeColor, accentColor, logoUrl, gstRate, branches: branchInput, adminPin, isOnboarded } = body;
  if (!name) return c.json({ error: 'Tenant business name is required' }, 400);

  const cleanId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').slice(0, 50) + '-' + Math.floor(1000 + Math.random() * 9000);
  const code = username ? username.toLowerCase().replace(/[^a-z0-9_]/g, '') : name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const user = username ? username.trim().toLowerCase() : code;
  const pass = password ? password.trim() : 'pos' + Math.floor(1000 + Math.random() * 9000);

  const branchDefs = (Array.isArray(branchInput) && branchInput.length > 0)
    ? branchInput.map((b, i) => ({
        id: String(b.id || `b${i + 1}`).replace(/[^a-z0-9_]/gi, '') || `b${i + 1}`,
        name: (b.name || `Branch ${i + 1}`).trim(),
        sortOrder: i,
        pin: String(b.pin || DEFAULT_BRANCH_DEFS[Math.min(i, DEFAULT_BRANCH_DEFS.length - 1)]?.defaultPin || '1111')
      }))
    : DEFAULT_BRANCH_DEFS.map((d, i) => ({ id: d.id, name: d.name, sortOrder: i, pin: d.defaultPin }));

  const plainPins = { admin: adminPin || '1234' };
  for (const b of branchDefs) plainPins[b.id] = b.pin;

  const branches = branchDefs.map(({ id, name, sortOrder }) => ({ id, name, sortOrder }));
  const hashedPw = await hashSecret(pass);
  const hashedPins = await hashPins(plainPins);

  const db = c.env.DB;
  await db.prepare(`
    INSERT INTO tenants (id, name, code, username, password, business_type, tagline, currency, theme_color, accent_color, logo_url, gst_rate, b1name, b2name, b3name, branches, pins, is_onboarded)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    cleanId, name.trim(), code, user, hashedPw,
    businessType || 'Food & Retail', tagline || 'Quality Products & Efficient Service',
    currency || '₹', themeColor || '#e4a11b', accentColor || '#111111', logoUrl || '',
    Number(gstRate ?? 5),
    branches[0]?.name || 'Branch 1', branches[1]?.name || 'Branch 2', branches[2]?.name || 'Branch 3',
    JSON.stringify(branches), JSON.stringify(hashedPins), isOnboarded ? 1 : 0
  ).run();

  for (let i = 0; i < DEFAULT_SEED_ITEMS.length; i++) {
    const p = DEFAULT_SEED_ITEMS[i];
    const seedId = `prod_${crypto.randomUUID().slice(0, 8)}`;
    const stock = {};
    for (const b of branches) stock[b.id] = p[b.id + 'Stock'] != null ? p[b.id + 'Stock'] : (p.b1Stock || 10);
    const item = normalizeProduct({ id: seedId, ...p, stock }, branches);
    await persistProduct(db, cleanId, item, branches);
  }

  const newTenant = { id: cleanId, name: name.trim(), code, username: user, businessType: businessType || 'Food & Retail', branches };
  return c.json({
    success: true,
    tenant: safePub(newTenant),
    credentials: { username: user, password: pass, adminPin: plainPins.admin, branchPins: Object.fromEntries(branchDefs.map(b => [b.id, b.pin])) }
  });
});

// Update tenant
app.put('/api/tenants/:tenantId', authRequired, requireTenantAccess, requireTenantAdmin, async (c) => {
  const tenantId = c.req.param('tenantId');
  const db = c.env.DB;
  const tenant = await loadTenant(db, tenantId);
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404);
  const updates = await c.req.json().catch(() => ({}));

  if (updates.password) {
    updates.password = isHashed(updates.password) ? updates.password : await hashSecret(updates.password);
  } else { delete updates.password; }

  let newBranches = tenant.branches;
  if (Array.isArray(updates.branches)) {
    newBranches = updates.branches.map((b, i) => ({
      id: String(b.id || `b${i + 1}`).replace(/[^a-z0-9_]/gi, '') || `b${i + 1}`,
      name: (b.name || `Branch ${i + 1}`).trim(),
      sortOrder: b.sortOrder != null ? Number(b.sortOrder) : i
    }));
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

  await db.prepare(`
    UPDATE tenants SET
      name = COALESCE(?, name), business_type = COALESCE(?, business_type),
      tagline = COALESCE(?, tagline), currency = COALESCE(?, currency),
      theme_color = COALESCE(?, theme_color), accent_color = COALESCE(?, accent_color),
      logo_url = COALESCE(?, logo_url), gst_rate = COALESCE(?, gst_rate),
      b1name = COALESCE(?, b1name), b2name = COALESCE(?, b2name), b3name = COALESCE(?, b3name),
      branches = ?, pins = ?,
      username = COALESCE(?, username), password = COALESCE(?, password),
      is_onboarded = COALESCE(?, is_onboarded)
    WHERE id = ?
  `).bind(
    updates.name || null, updates.businessType || null, updates.tagline || null,
    updates.currency || null, updates.themeColor || null, updates.accentColor || null,
    updates.logoUrl || null, updates.gstRate != null ? Number(updates.gstRate) : null,
    newBranches[0]?.name || null, newBranches[1]?.name || null, newBranches[2]?.name || null,
    JSON.stringify(newBranches), JSON.stringify(newPins),
    updates.username || null, updates.password || null,
    updates.isOnboarded != null ? (updates.isOnboarded ? 1 : 0) : null,
    tenantId
  ).run();

  const updated = await loadTenant(db, tenantId);
  return c.json({ success: true, tenant: safePub(updated) });
});

// Delete tenant
app.delete('/api/tenants/:tenantId', authRequired, requireSuperAdmin, async (c) => {
  const tenantId = c.req.param('tenantId');
  const db = c.env.DB;
  await db.prepare('DELETE FROM transfers WHERE tenant_id = ?').bind(tenantId).run();
  await db.prepare('DELETE FROM stock_logs WHERE tenant_id = ?').bind(tenantId).run();
  await db.prepare('DELETE FROM sales WHERE tenant_id = ?').bind(tenantId).run();
  await db.prepare('DELETE FROM products WHERE tenant_id = ?').bind(tenantId).run();
  await db.prepare('DELETE FROM tenants WHERE id = ?').bind(tenantId).run();
  return c.json({ success: true });
});

// Get tenant data bundle
app.get('/api/tenant/:tenantId/data', authRequired, requireTenantAccess, async (c) => {
  const tenantId = c.req.param('tenantId');
  const db = c.env.DB;
  const tenant = await loadTenant(db, tenantId);
  if (!tenant) return c.json({ error: 'Client tenant not found' }, 404);
  const branches = tenant.branches;

  const { results: prodRows } = await db.prepare('SELECT * FROM products WHERE tenant_id = ? ORDER BY name ASC').bind(tenantId).all();
  const products = prodRows.map(r => mapProduct(r, branches));

  const { results: saleRows } = await db.prepare('SELECT * FROM sales WHERE tenant_id = ? ORDER BY ts DESC LIMIT 500').bind(tenantId).all();
  const sales = saleRows.map(r => ({
    id: r.id, billNo: r.bill_no, branch: r.branch,
    subtotal: Number(r.subtotal), tax: Number(r.tax), discount: Number(r.discount || 0),
    total: Number(r.total), payMethod: r.payment_method,
    items: j(r.items), customerName: r.customer_name, customerPhone: r.customer_phone,
    custName: r.customer_name, custPhone: r.customer_phone,
    cashier: r.cashier, ts: r.ts
  }));

  const { results: logRows } = await db.prepare('SELECT * FROM stock_logs WHERE tenant_id = ? ORDER BY ts DESC LIMIT 500').bind(tenantId).all();
  const stockLogs = logRows.map(r => ({
    id: r.id, branch: r.branch, productName: r.product_name,
    change: Number(r.change), reason: r.reason, ts: r.ts
  }));

  const { results: trRows } = await db.prepare('SELECT * FROM transfers WHERE tenant_id = ? ORDER BY ts DESC LIMIT 500').bind(tenantId).all();
  const transfers = trRows.map(r => ({
    id: r.id, productName: r.product_name,
    fromBranch: r.from_branch, toBranch: r.to_branch,
    qty: Number(r.qty), note: r.note, ts: r.ts
  }));

  return c.json({ success: true, tenant: safePub(tenant), branches, products, sales, stockLogs, transfers });
});

// Products CRUD
app.post('/api/tenant/:tenantId/products', authRequired, requireTenantAccess, requireTenantAdmin, async (c) => {
  const tenantId = c.req.param('tenantId');
  const db = c.env.DB;
  const tenant = await loadTenant(db, tenantId);
  const branches = tenant ? tenant.branches : normalizeBranches({});
  const body = await c.req.json().catch(() => ({}));
  const newId = body.id || `prod_${crypto.randomUUID().slice(0, 8)}`;
  const stock = body.stock && typeof body.stock === 'object' ? body.stock : getProductStockMap(body, branches.map(b => b.id));
  const item = normalizeProduct({ ...body, id: newId, stock }, branches);
  await persistProduct(db, tenantId, item, branches);
  return c.json({ success: true, product: item });
});

app.put('/api/tenant/:tenantId/products/:id', authRequired, requireTenantAccess, requireTenantAdmin, async (c) => {
  const { tenantId, id } = { tenantId: c.req.param('tenantId'), id: c.req.param('id') };
  const db = c.env.DB;
  const tenant = await loadTenant(db, tenantId);
  const branches = tenant ? tenant.branches : normalizeBranches({});
  const updates = await c.req.json().catch(() => ({}));

  const existing = await db.prepare('SELECT * FROM products WHERE tenant_id = ? AND id = ?').bind(tenantId, id).first();
  const current = existing ? mapProduct(existing, branches) : { id };
  const merged = normalizeProduct({ ...current, ...updates, id }, branches);
  if (updates.stock) { for (const [bid, qty] of Object.entries(updates.stock)) setStock(merged, bid, qty); }
  for (const b of branches) {
    const lk = b.id + 'Stock';
    if (updates[lk] != null) setStock(merged, b.id, updates[lk]);
  }
  await persistProduct(db, tenantId, merged, branches);
  return c.json({ success: true, product: merged });
});

app.delete('/api/tenant/:tenantId/products/:id', authRequired, requireTenantAccess, requireTenantAdmin, async (c) => {
  const db = c.env.DB;
  await db.prepare('DELETE FROM products WHERE tenant_id = ? AND id = ?').bind(c.req.param('tenantId'), c.req.param('id')).run();
  return c.json({ success: true });
});

// Sales
app.post('/api/tenant/:tenantId/sales', authRequired, requireTenantAccess, async (c) => {
  const tenantId = c.req.param('tenantId');
  const db = c.env.DB;
  const sale = await c.req.json().catch(() => ({}));
  const tenant = await loadTenant(db, tenantId);
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

  await db.prepare(`
    INSERT INTO sales (id, tenant_id, bill_no, branch, subtotal, tax, discount, total, payment_method, items, customer_name, customer_phone, cashier, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `).bind(
    saleId, tenantId, newSale.billNo || null, newSale.branch,
    newSale.subtotal || 0, newSale.tax || 0, newSale.discount || 0, newSale.total || 0,
    newSale.payMethod, JSON.stringify(newSale.items || []),
    newSale.customerName, newSale.customerPhone, newSale.cashier, newSale.ts
  ).run();

  const touched = [];
  if (Array.isArray(newSale.items)) {
    for (const cartItem of newSale.items) {
      const pid = cartItem.id || cartItem.productId;
      const row = await db.prepare('SELECT * FROM products WHERE tenant_id = ? AND id = ?').bind(tenantId, pid).first();
      if (row) {
        const prod = mapProduct(row, branches);
        applyStockDelta(prod, branchId, -(cartItem.qty || 1));
        normalizeProduct(prod, branches);
        await persistProduct(db, tenantId, prod, branches);
        touched.push(prod);
      }
    }
  }
  return c.json({ success: true, sale: newSale, products: touched });
});

// Stock logs
app.post('/api/tenant/:tenantId/stock-log', authRequired, requireTenantAccess, requireTenantAdmin, async (c) => {
  const tenantId = c.req.param('tenantId');
  const body = await c.req.json().catch(() => ({}));
  const log = { id: `log_${Date.now()}`, ...body, ts: new Date().toISOString() };
  await c.env.DB.prepare(`
    INSERT INTO stock_logs (id, tenant_id, branch, product_name, change, reason, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING
  `).bind(log.id, tenantId, log.branch || null, log.productName || log.product_name || '', log.change || 0, log.reason || '', log.ts).run();
  return c.json({ success: true, log });
});

// Transfers
app.post('/api/tenant/:tenantId/transfers', authRequired, requireTenantAccess, requireTenantAdmin, async (c) => {
  const tenantId = c.req.param('tenantId');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const tenant = await loadTenant(db, tenantId);
  const branches = tenant ? tenant.branches : normalizeBranches({});
  const fromBranch = body.fromBranch || body.from;
  const toBranch = body.toBranch || body.to;
  const qty = Number(body.qty || 0);
  const productId = body.productId || body.itemId;

  if (!fromBranch || !toBranch || fromBranch === toBranch) return c.json({ error: 'fromBranch and toBranch must differ' }, 400);
  if (!productId || qty <= 0) return c.json({ error: 'productId and positive qty required' }, 400);

  const row = await db.prepare('SELECT * FROM products WHERE tenant_id = ? AND id = ?').bind(tenantId, productId).first();
  if (!row) return c.json({ error: 'Product not found' }, 404);
  const prod = mapProduct(row, branches);

  const available = getStock(prod, fromBranch);
  if (available < qty) return c.json({ error: `Insufficient stock at source (have ${available})` }, 400);

  applyStockDelta(prod, fromBranch, -qty);
  applyStockDelta(prod, toBranch, qty);
  normalizeProduct(prod, branches);
  await persistProduct(db, tenantId, prod, branches);

  const transfer = {
    id: `tr_${Date.now()}`, productId: prod.id, productName: prod.name,
    fromBranch, toBranch, qty, note: body.note || '', ts: new Date().toISOString()
  };
  await db.prepare(`
    INSERT INTO transfers (id, tenant_id, product_name, from_branch, to_branch, qty, note, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING
  `).bind(transfer.id, tenantId, transfer.productName, transfer.fromBranch, transfer.toBranch, transfer.qty, transfer.note, transfer.ts).run();

  return c.json({ success: true, transfer, product: prod });
});

// DB status
app.get('/api/db-status', (c) => {
  return c.json({
    isPostgresConnected: false,
    databaseUrlSet: true,
    storageType: 'Cloudflare D1 (SQLite at Edge)',
    totalTenants: -1
  });
});

// Health
app.get('/api/health', (c) => c.json({ ok: true, runtime: 'cloudflare-workers' }));

// Export
export default {
  async fetch(request, env, ctx) {
    try { await seedIfEmpty(env.DB); } catch (e) { console.error('Seed error:', e); }
    return app.fetch(request, env, ctx);
  }
};
