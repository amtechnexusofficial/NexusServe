import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  hashSecret,
  verifySecret,
  hashPins,
  isBcryptHash,
  signToken,
  publicTenant,
  authRequired,
  requireSuperAdmin,
  requireTenantAccess,
  requireTenantAdmin
} from './auth.js';
import {
  normalizeBranches,
  ensureTenantBranches,
  normalizeProduct,
  getProductStockMap,
  getStock,
  setStock,
  applyStockDelta,
  isValidStaffRole,
  branchLabel,
  DEFAULT_BRANCH_DEFS
} from './data-model.js';

dotenv.config();

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Database setup: Use PostgreSQL/Neon if DATABASE_URL is set, otherwise use resilient JSON file store
let pool = null;
if (process.env.DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    });
    console.log('PostgreSQL/Neon pool configured.');
  } catch (err) {
    console.error('Error configuring PG pool:', err);
  }
}

const LOCAL_DB_FILE = path.join(__dirname, 'pos_tenants_data.json');

// Initialize local fallback storage structure
function loadLocalData() {
  try {
    if (fs.existsSync(LOCAL_DB_FILE)) {
      const raw = fs.readFileSync(LOCAL_DB_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Error loading local DB:', e);
  }
  return {
    tenants: [
      {
        id: 'nb-cakes',
        name: 'NB Cakes & Desserts',
        code: 'nb',
        businessType: 'Bakery & Cake Shop',
        tagline: 'Freshly Baked Goodness & Artisan Cakes',
        currency: '₹',
        themeColor: '#c8860a',
        accentColor: '#3d1f0a',
        logoUrl: '',
        gstRate: 5,
        b1name: 'Flagship Store',
        b2name: 'Express Kiosk',
        b3name: 'Delivery Hub',
        pins: { admin: '1234', b1: '1111', b2: '2222', b3: '3333' },
        createdAt: new Date().toISOString()
      },
      {
        id: 'urban-bites',
        name: 'Urban Bites & Cafe',
        code: 'ub',
        businessType: 'Cafe & Fast Food',
        tagline: 'Artisanal Coffee & Gourmet Street Food',
        currency: '$',
        themeColor: '#2563eb',
        accentColor: '#0f172a',
        logoUrl: '',
        gstRate: 8,
        b1name: 'Main Cafe',
        b2name: 'Drive Thru',
        b3name: 'Pop-up Cart',
        pins: { admin: '1234', b1: '1111', b2: '2222', b3: '3333' },
        createdAt: new Date().toISOString()
      }
    ],
    products: {},
    sales: {},
    stockLogs: {},
    transfers: {}
  };
}

let localDb = loadLocalData();

function saveLocalData() {
  try {
    fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify(localDb, null, 2));
  } catch (e) {
    console.error('Error saving local DB:', e);
  }
}

function findLocalTenant(tenantId) {
  return localDb.tenants.find(t => t.id === tenantId) || null;
}

async function persistTenantSecrets(tenant) {
  const idx = localDb.tenants.findIndex(t => t.id === tenant.id);
  if (idx >= 0) {
    localDb.tenants[idx] = tenant;
    saveLocalData();
  }
  if (pool) {
    try {
      await pool.query(
        'UPDATE tenants SET password = $1, pins = $2 WHERE id = $3',
        [tenant.password, JSON.stringify(tenant.pins || {}), tenant.id]
      );
    } catch (e) {
      console.error('Failed to persist hashed secrets to PG:', e.message);
    }
  }
}

async function migrateLocalSecrets() {
  let changed = false;
  for (const tenant of localDb.tenants) {
    if (tenant.password && !isBcryptHash(tenant.password)) {
      tenant.password = await hashSecret(tenant.password);
      changed = true;
    }
    if (tenant.pins && typeof tenant.pins === 'object') {
      const next = await hashPins(tenant.pins);
      if (JSON.stringify(next) !== JSON.stringify(tenant.pins)) {
        tenant.pins = next;
        changed = true;
      }
    }
  }
  if (changed) {
    saveLocalData();
    console.log('[auth] Migrated plaintext passwords/PINs in local store to bcrypt hashes.');
  }
}

async function loadTenantRecord(tenantId) {
  if (pool) {
    try {
      const q = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
      if (q.rows.length) return mapPgTenantRow(q.rows[0]);
    } catch (e) {
      console.error('PG tenant load failed:', e.message);
    }
  }
  const local = findLocalTenant(tenantId);
  if (local) ensureTenantBranches(local);
  return local;
}

function mapPgTenantRow(r) {
  const tenant = {
    id: r.id,
    name: r.name,
    code: r.code,
    username: r.username || r.code,
    password: r.password,
    businessType: r.business_type,
    tagline: r.tagline,
    currency: r.currency,
    themeColor: r.theme_color,
    accentColor: r.accent_color,
    logoUrl: r.logo_url,
    gstRate: Number(r.gst_rate || 0),
    b1name: r.b1name,
    b2name: r.b2name,
    b3name: r.b3name,
    pins: typeof r.pins === 'string' ? JSON.parse(r.pins) : (r.pins || {}),
    isOnboarded: r.is_onboarded !== false,
    branches: r.branches
      ? (typeof r.branches === 'string' ? JSON.parse(r.branches) : r.branches)
      : undefined
  };
  ensureTenantBranches(tenant);
  return tenant;
}

function mapPgProductRow(r, branches = []) {
  const stockFromCol = r.stock
    ? (typeof r.stock === 'string' ? JSON.parse(r.stock) : r.stock)
    : null;
  const product = {
    id: r.id,
    name: r.name,
    cat: r.cat,
    price: Number(r.price),
    cost: Number(r.cost || 0),
    b1Stock: Number(r.b1_stock || 0),
    b2Stock: Number(r.b2_stock || 0),
    b3Stock: Number(r.b3_stock || 0),
    stock: stockFromCol || undefined,
    reorder: Number(r.reorder || 5),
    unit: r.unit || 'pcs'
  };
  return normalizeProduct(product, branches.length ? branches : normalizeBranches({}));
}

function safePublicTenant(tenant) {
  if (!tenant) return null;
  ensureTenantBranches(tenant);
  return publicTenant(tenant);
}

async function persistProductToPg(tenantId, product, branches) {
  if (!pool) return;
  const normalized = normalizeProduct({ ...product }, branches);
  const stock = getProductStockMap(normalized, branches.map(b => b.id));
  try {
    await pool.query(`
      INSERT INTO products (id, tenant_id, name, cat, price, cost, b1_stock, b2_stock, b3_stock, stock, reorder, unit)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        cat = EXCLUDED.cat,
        price = EXCLUDED.price,
        cost = EXCLUDED.cost,
        b1_stock = EXCLUDED.b1_stock,
        b2_stock = EXCLUDED.b2_stock,
        b3_stock = EXCLUDED.b3_stock,
        stock = EXCLUDED.stock,
        reorder = EXCLUDED.reorder,
        unit = EXCLUDED.unit
    `, [
      normalized.id, tenantId, normalized.name, normalized.cat, normalized.price, normalized.cost || 0,
      stock.b1 || 0, stock.b2 || 0, stock.b3 || 0, JSON.stringify(stock),
      normalized.reorder || 5, normalized.unit || 'pcs'
    ]);
  } catch (e) {
    console.error('persistProductToPg failed:', e.message);
  }
}

function migrateBranchShapes() {
  let changed = false;
  for (const tenant of localDb.tenants) {
    const before = JSON.stringify(tenant.branches || null);
    ensureTenantBranches(tenant);
    // Ensure pins exist for each branch id
    if (!tenant.pins) tenant.pins = {};
    for (const b of tenant.branches) {
      if (tenant.pins[b.id] == null && DEFAULT_BRANCH_DEFS.find(d => d.id === b.id)) {
        // leave missing; verify will fail until set — seed defaults only if completely empty legacy
      }
    }
    if (JSON.stringify(tenant.branches) !== before) changed = true;

    const prods = localDb.products[tenant.id] || [];
    for (const p of prods) {
      const beforeP = JSON.stringify(p.stock || null);
      normalizeProduct(p, tenant.branches);
      if (JSON.stringify(p.stock) !== beforeP) changed = true;
    }
  }
  if (changed) {
    saveLocalData();
    console.log('[data] Migrated tenants/products to branches[] + stock{} shape.');
  }
}

// Initial default seed products for standard businesses
const DEFAULT_SEED_ITEMS = [
  { name: 'Signature Chocolate Brownie', cat: 'Brownies', price: 95, cost: 45, b1Stock: 35, b2Stock: 20, b3Stock: 15, reorder: 10, unit: 'pcs' },
  { name: 'Red Velvet Classic Slice', cat: 'Cakes', price: 120, cost: 55, b1Stock: 20, b2Stock: 12, b3Stock: 8, reorder: 5, unit: 'pcs' },
  { name: 'Nutella Stuffed Bun', cat: 'Buns', price: 80, cost: 35, b1Stock: 25, b2Stock: 15, b3Stock: 10, reorder: 8, unit: 'pcs' },
  { name: 'Tres Leches Classic Box', cat: 'Tres Leches', price: 180, cost: 85, b1Stock: 15, b2Stock: 10, b3Stock: 5, reorder: 5, unit: 'pcs' },
  { name: 'Lotus Biscoff Cheesecake', cat: 'Cheesecake', price: 190, cost: 90, b1Stock: 18, b2Stock: 8, b3Stock: 6, reorder: 5, unit: 'pcs' },
  { name: 'Iced Caramel Macchiato', cat: 'Beverages', price: 130, cost: 40, b1Stock: 50, b2Stock: 40, b3Stock: 30, reorder: 15, unit: 'cups' }
];

// Ensure initial seed for default tenants
if (!localDb.products['nb-cakes'] || localDb.products['nb-cakes'].length === 0) {
  localDb.products['nb-cakes'] = DEFAULT_SEED_ITEMS.map((item, idx) => ({
    id: 'prod_' + (idx + 1),
    ...item
  }));
  saveLocalData();
}

if (!localDb.products['urban-bites'] || localDb.products['urban-bites'].length === 0) {
  localDb.products['urban-bites'] = [
    { id: 'ub_1', name: 'Smash Truffle Burger', cat: 'Burgers', price: 12, cost: 5, b1Stock: 40, b2Stock: 25, b3Stock: 15, reorder: 10, unit: 'pcs' },
    { id: 'ub_2', name: 'Loaded Peri-Peri Fries', cat: 'Sides', price: 6, cost: 2, b1Stock: 60, b2Stock: 40, b3Stock: 20, reorder: 15, unit: 'pcs' },
    { id: 'ub_3', name: 'Cold Brew Oat Latte', cat: 'Beverages', price: 5.5, cost: 1.8, b1Stock: 50, b2Stock: 30, b3Stock: 25, reorder: 10, unit: 'cups' }
  ];
  saveLocalData();
}

// Ensure database table if using Postgres
async function initPgTables() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id VARCHAR(100) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        code VARCHAR(50) UNIQUE,
        username VARCHAR(100) UNIQUE,
        password VARCHAR(255),
        business_type VARCHAR(100),
        tagline TEXT,
        currency VARCHAR(10) DEFAULT '$',
        theme_color VARCHAR(50) DEFAULT '#c8860a',
        accent_color VARCHAR(50) DEFAULT '#3d1f0a',
        logo_url TEXT,
        gst_rate NUMERIC DEFAULT 5,
        b1name VARCHAR(100) DEFAULT 'Branch 1',
        b2name VARCHAR(100) DEFAULT 'Branch 2',
        b3name VARCHAR(100) DEFAULT 'Branch 3',
        pins JSONB DEFAULT '{}',
        is_onboarded BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Ensure username column exists if table was created previously
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS username VARCHAR(100);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS password VARCHAR(255);
      ALTER TABLE tenants ALTER COLUMN password TYPE VARCHAR(255);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS branches JSONB;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_onboarded BOOLEAN DEFAULT true;

      ALTER TABLE products ADD COLUMN IF NOT EXISTS stock JSONB;

      CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(100) PRIMARY KEY,
        tenant_id VARCHAR(100) REFERENCES tenants(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        cat VARCHAR(100),
        price NUMERIC NOT NULL,
        cost NUMERIC DEFAULT 0,
        b1_stock NUMERIC DEFAULT 0,
        b2_stock NUMERIC DEFAULT 0,
        b3_stock NUMERIC DEFAULT 0,
        reorder NUMERIC DEFAULT 5,
        unit VARCHAR(50) DEFAULT 'pcs',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sales (
        id VARCHAR(100) PRIMARY KEY,
        tenant_id VARCHAR(100) REFERENCES tenants(id) ON DELETE CASCADE,
        bill_no VARCHAR(100),
        branch VARCHAR(50),
        subtotal NUMERIC,
        tax NUMERIC,
        discount NUMERIC DEFAULT 0,
        total NUMERIC,
        payment_method VARCHAR(50),
        items JSONB,
        customer_name VARCHAR(100),
        customer_phone VARCHAR(50),
        cashier VARCHAR(100),
        ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS stock_logs (
        id VARCHAR(100) PRIMARY KEY,
        tenant_id VARCHAR(100) REFERENCES tenants(id) ON DELETE CASCADE,
        branch VARCHAR(50),
        product_name VARCHAR(255),
        change NUMERIC,
        reason VARCHAR(255),
        ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS transfers (
        id VARCHAR(100) PRIMARY KEY,
        tenant_id VARCHAR(100) REFERENCES tenants(id) ON DELETE CASCADE,
        product_name VARCHAR(255),
        from_branch VARCHAR(50),
        to_branch VARCHAR(50),
        qty NUMERIC,
        status VARCHAR(50) DEFAULT 'completed',
        ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Postgres tables verified.');

    // Seed default tenants into PG if none exist
    const countCheck = await pool.query('SELECT count(*) FROM tenants');
    if (parseInt(countCheck.rows[0].count, 10) === 0) {
      console.log('Seeding initial multi-tenant workspaces into PostgreSQL...');
      for (const t of localDb.tenants) {
        await pool.query(`
          INSERT INTO tenants (id, name, code, username, password, business_type, tagline, currency, theme_color, accent_color, logo_url, gst_rate, b1name, b2name, b3name, pins, is_onboarded)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
          ON CONFLICT (id) DO NOTHING
        `, [
          t.id, t.name, t.code, t.username || t.code, t.password || 'pos123', t.businessType, t.tagline, t.currency,
          t.themeColor, t.accentColor, t.logoUrl || '', t.gstRate || 5,
          t.b1name, t.b2name, t.b3name, JSON.stringify(t.pins), t.isOnboarded !== false
        ]);

        const prods = localDb.products[t.id] || [];
        for (const p of prods) {
          await pool.query(`
            INSERT INTO products (id, tenant_id, name, cat, price, cost, b1_stock, b2_stock, b3_stock, reorder, unit)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (id) DO NOTHING
          `, [
            p.id, t.id, p.name, p.cat, p.price, p.cost || 0,
            p.b1Stock || 0, p.b2Stock || 0, p.b3Stock || 0, p.reorder || 5, p.unit || 'pcs'
          ]);
        }
      }
      console.log('PostgreSQL initial seed complete.');
    }
  } catch (e) {
    console.error('Postgres table init error:', e);
  }
}
initPgTables();
await migrateLocalSecrets();
migrateBranchShapes();

// ──────── API ROUTES ────────

// 0. Super-Admin Master Login (AMtechnexus)
const SUPER_ADMIN_CREDENTIALS = {
  username: process.env.SUPER_ADMIN_USER || 'admin@amtechnexus.com',
  password: process.env.SUPER_ADMIN_PASSWORD || 'amtech2026'
};

app.post('/api/superadmin/login', async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || body.email || body.user || '').trim();
  const password = String(body.password || '');
  const userOk = username === SUPER_ADMIN_CREDENTIALS.username || username === 'admin';
  const passOk = password === SUPER_ADMIN_CREDENTIALS.password;
  if (!userOk || !passOk) {
    return res.status(401).json({ error: 'Invalid master super-admin credentials' });
  }
  const token = signToken({ role: 'superadmin', name: 'AMtechnexus Master Control' });
  return res.json({
    success: true,
    role: 'superadmin',
    name: 'AMtechnexus Master Control',
    token
  });
});

// 1. Customer Tenant Login via Username + Password
app.post('/api/tenant/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const u = username.trim().toLowerCase();
  let found = null;

  if (pool) {
    try {
      const q = await pool.query('SELECT * FROM tenants WHERE LOWER(username) = $1 OR LOWER(code) = $1', [u]);
      if (q.rows.length > 0) found = mapPgTenantRow(q.rows[0]);
    } catch (e) {
      console.error('PG tenant login lookup failed:', e);
    }
  }

  if (!found) {
    found = localDb.tenants.find(t =>
      (t.username && t.username.toLowerCase() === u) || (t.code && t.code.toLowerCase() === u)
    ) || null;
  }

  if (!found || !(await verifySecret(password.trim(), found.password))) {
    return res.status(401).json({ error: 'Invalid username or password. Contact AMtechnexus support if needed.' });
  }

  // Lazy-migrate plaintext password
  if (found.password && !isBcryptHash(found.password)) {
    found.password = await hashSecret(password.trim());
    await persistTenantSecrets(found);
  }

  const token = signToken({
    role: 'tenant',
    tenantId: found.id,
    staffRole: 'admin'
  });

  return res.json({ success: true, token, tenant: safePublicTenant(found) });
});

// Public shop profile (no secrets) for customer portal links
app.get('/api/tenants/:tenantId/public', async (req, res) => {
  const tenant = await loadTenantRecord(req.params.tenantId);
  if (!tenant) return res.status(404).json({ error: 'Shop not found' });
  return res.json({ success: true, tenant: safePublicTenant(tenant) });
});

// Staff PIN unlock — issues a tenant-scoped JWT
app.post('/api/tenants/:tenantId/verify-pin', async (req, res) => {
  const { role, pin } = req.body || {};
  const staffRole = String(role || '').trim();
  if (!pin || String(pin).length < 4) {
    return res.status(400).json({ error: 'PIN required' });
  }

  const tenant = await loadTenantRecord(req.params.tenantId);
  if (!tenant) return res.status(404).json({ error: 'Shop not found' });
  ensureTenantBranches(tenant);

  if (!isValidStaffRole(tenant, staffRole)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const pins = tenant.pins || {};
  const stored = pins[staffRole];
  if (!(await verifySecret(String(pin), stored))) {
    return res.status(401).json({ error: 'Incorrect PIN' });
  }

  if (stored && !isBcryptHash(stored)) {
    pins[staffRole] = await hashSecret(String(pin));
    tenant.pins = pins;
    await persistTenantSecrets(tenant);
  }

  const token = signToken({
    role: 'tenant',
    tenantId: tenant.id,
    staffRole
  });

  return res.json({
    success: true,
    token,
    staffRole,
    tenant: safePublicTenant(tenant)
  });
});

// 2. Get List of Available Tenants (superadmin only)
app.get('/api/tenants', authRequired, requireSuperAdmin, async (req, res) => {
  if (pool) {
    try {
      const result = await pool.query('SELECT * FROM tenants ORDER BY created_at ASC');
      return res.json({
        success: true,
        tenants: result.rows.map(r => safePublicTenant(mapPgTenantRow(r)))
      });
    } catch (e) {
      console.error('Failed to load tenants from PG:', e);
    }
  }
  return res.json({ success: true, tenants: localDb.tenants.map(safePublicTenant) });
});

// 3. Register / Create New Client Credentials (by AMtechnexus)
app.post('/api/tenants', authRequired, requireSuperAdmin, async (req, res) => {
  const { name, username, password, businessType, tagline, currency, themeColor, accentColor, logoUrl, gstRate, branches: branchInput, adminPin, isOnboarded } = req.body;
  if (!name) return res.status(400).json({ error: 'Tenant business name is required' });

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

  const newTenant = {
    id: cleanId,
    name: name.trim(),
    code,
    username: user,
    password: await hashSecret(pass),
    businessType: businessType || 'Food & Retail',
    tagline: tagline || 'Quality Products & Efficient Service',
    currency: currency || '₹',
    themeColor: themeColor || '#e4a11b',
    accentColor: accentColor || '#111111',
    logoUrl: logoUrl || '',
    gstRate: Number(gstRate ?? 5),
    branches: branchDefs.map(({ id, name, sortOrder }) => ({ id, name, sortOrder })),
    pins: await hashPins(plainPins),
    isOnboarded: isOnboarded === true ? true : false,
    createdAt: new Date().toISOString()
  };
  ensureTenantBranches(newTenant);

  if (pool) {
    try {
      await pool.query(`
        INSERT INTO tenants (id, name, code, username, password, business_type, tagline, currency, theme_color, accent_color, logo_url, gst_rate, b1name, b2name, b3name, branches, pins, is_onboarded)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      `, [
        newTenant.id, newTenant.name, newTenant.code, newTenant.username, newTenant.password,
        newTenant.businessType, newTenant.tagline, newTenant.currency, newTenant.themeColor,
        newTenant.accentColor, newTenant.logoUrl, newTenant.gstRate,
        newTenant.b1name || null, newTenant.b2name || null, newTenant.b3name || null,
        JSON.stringify(newTenant.branches), JSON.stringify(newTenant.pins), newTenant.isOnboarded
      ]);

      for (let i = 0; i < DEFAULT_SEED_ITEMS.length; i++) {
        const p = DEFAULT_SEED_ITEMS[i];
        const seedId = 'prod_' + uuidv4().slice(0, 8);
        const stock = {};
        for (const b of newTenant.branches) {
          stock[b.id] = p[b.id + 'Stock'] != null ? p[b.id + 'Stock'] : (p.b1Stock || 10);
        }
        const item = normalizeProduct({
          id: seedId, name: p.name, cat: p.cat, price: p.price, cost: p.cost || 0,
          stock, reorder: p.reorder || 5, unit: p.unit || 'pcs'
        }, newTenant.branches);
        await persistProductToPg(newTenant.id, item, newTenant.branches);
      }
    } catch (e) {
      console.error('Error inserting tenant into PG:', e);
    }
  }

  localDb.tenants.push(newTenant);
  localDb.products[newTenant.id] = DEFAULT_SEED_ITEMS.map((item, idx) => {
    const stock = {};
    for (const b of newTenant.branches) {
      stock[b.id] = item[b.id + 'Stock'] != null ? item[b.id + 'Stock'] : (item.b1Stock || 10);
    }
    return normalizeProduct({
      id: `prod_${newTenant.id.slice(0, 6)}_${idx + 1}`,
      name: item.name, cat: item.cat, price: item.price, cost: item.cost || 0,
      stock, reorder: item.reorder || 5, unit: item.unit || 'pcs'
    }, newTenant.branches);
  });
  localDb.sales[newTenant.id] = [];
  localDb.stockLogs[newTenant.id] = [];
  localDb.transfers[newTenant.id] = [];
  saveLocalData();

  return res.json({
    success: true,
    tenant: safePublicTenant(newTenant),
    credentials: {
      username: user,
      password: pass,
      adminPin: plainPins.admin,
      branchPins: Object.fromEntries(branchDefs.map(b => [b.id, b.pin]))
    }
  });
});

// 4. Update Client Branding & Settings (including Logo Upload & Onboarding Completion)
app.put('/api/tenants/:tenantId', authRequired, requireTenantAccess, requireTenantAdmin, async (req, res) => {
  const { tenantId } = req.params;
  const updates = { ...(req.body || {}) };

  let tenant = localDb.tenants.find(t => t.id === tenantId);
  if (!tenant) {
    // Hydrate from PG into local cache if needed
    const loaded = await loadTenantRecord(tenantId);
    if (!loaded) return res.status(404).json({ error: 'Tenant not found' });
    localDb.tenants.push(loaded);
    tenant = loaded;
  }

  if (updates.password) {
    updates.password = isBcryptHash(updates.password)
      ? updates.password
      : await hashSecret(updates.password);
  } else {
    delete updates.password;
  }

  if (Array.isArray(updates.branches)) {
    updates.branches = updates.branches.map((b, i) => ({
      id: String(b.id || `b${i + 1}`).replace(/[^a-z0-9_]/gi, '') || `b${i + 1}`,
      name: (b.name || `Branch ${i + 1}`).trim(),
      sortOrder: b.sortOrder != null ? Number(b.sortOrder) : i
    }));
  }

  if (updates.pinPlaintext && typeof updates.pinPlaintext === 'object') {
    const mergedPins = { ...(tenant.pins || {}) };
    for (const [role, plain] of Object.entries(updates.pinPlaintext)) {
      if (plain == null || String(plain).trim() === '') continue;
      mergedPins[role] = await hashSecret(String(plain).trim());
    }
    updates.pins = mergedPins;
    delete updates.pinPlaintext;
  } else if (updates.pins && typeof updates.pins === 'object') {
    updates.pins = await hashPins(updates.pins);
  } else {
    delete updates.pins;
  }

  Object.assign(tenant, updates);
  ensureTenantBranches(tenant);

  // Ensure every product has stock keys for the current branch set
  if (Array.isArray(updates.branches) && localDb.products[tenantId]) {
    localDb.products[tenantId] = localDb.products[tenantId].map(p => {
      const normalized = normalizeProduct({ ...p }, tenant.branches);
      return normalized;
    });
    if (pool) {
      for (const p of localDb.products[tenantId]) {
        await persistProductToPg(tenantId, p, tenant.branches);
      }
    }
  }

  saveLocalData();

  if (pool) {
    try {
      await pool.query(`
        UPDATE tenants SET
          name = COALESCE($1, name),
          business_type = COALESCE($2, business_type),
          tagline = COALESCE($3, tagline),
          currency = COALESCE($4, currency),
          theme_color = COALESCE($5, theme_color),
          accent_color = COALESCE($6, accent_color),
          logo_url = COALESCE($7, logo_url),
          gst_rate = COALESCE($8, gst_rate),
          b1name = COALESCE($9, b1name),
          b2name = COALESCE($10, b2name),
          b3name = COALESCE($11, b3name),
          branches = COALESCE($12, branches),
          pins = COALESCE($13, pins),
          username = COALESCE($14, username),
          password = COALESCE($15, password),
          is_onboarded = COALESCE($16, is_onboarded)
        WHERE id = $17
      `, [
        updates.name, updates.businessType, updates.tagline, updates.currency,
        updates.themeColor, updates.accentColor, updates.logoUrl, updates.gstRate,
        tenant.b1name || null, tenant.b2name || null, tenant.b3name || null,
        updates.branches ? JSON.stringify(tenant.branches) : null,
        updates.pins ? JSON.stringify(tenant.pins) : null,
        updates.username, updates.password || null, updates.isOnboarded,
        tenantId
      ]);
    } catch (e) {
      console.error('Error updating tenant in PG:', e);
    }
  }

  return res.json({ success: true, tenant: safePublicTenant(tenant) });
});

// 5. Delete Tenant (Super-Admin only)
app.delete('/api/tenants/:tenantId', authRequired, requireSuperAdmin, async (req, res) => {
  const { tenantId } = req.params;
  localDb.tenants = localDb.tenants.filter(t => t.id !== tenantId);
  delete localDb.products[tenantId];
  delete localDb.sales[tenantId];
  delete localDb.stockLogs[tenantId];
  delete localDb.transfers[tenantId];
  saveLocalData();

  if (pool) {
    try {
      await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    } catch (e) {
      console.error('Error deleting tenant from PG:', e);
    }
  }
  return res.json({ success: true });
});

// 6. Get Tenant Specific Isolated Data Bundle (Products, Sales, Logs, Transfers)
app.get('/api/tenant/:tenantId/data', authRequired, requireTenantAccess, async (req, res) => {
  const { tenantId } = req.params;
  let tenant = localDb.tenants.find(t => t.id === tenantId) || await loadTenantRecord(tenantId);
  if (!tenant) return res.status(404).json({ error: 'Client tenant not found' });
  ensureTenantBranches(tenant);
  const branches = tenant.branches;

  let products = (localDb.products[tenantId] || []).map(p => normalizeProduct({ ...p }, branches));
  let sales = localDb.sales[tenantId] || [];
  let stockLogs = localDb.stockLogs[tenantId] || [];
  let transfers = localDb.transfers[tenantId] || [];

  if (pool) {
    try {
      const pRes = await pool.query('SELECT * FROM products WHERE tenant_id = $1 ORDER BY name ASC', [tenantId]);
      if (pRes.rows.length > 0) {
        products = pRes.rows.map(r => mapPgProductRow(r, branches));
        // Mirror PG → localDb so fallback stays consistent
        localDb.products[tenantId] = products.map(p => ({ ...p }));
      }

      const sRes = await pool.query('SELECT * FROM sales WHERE tenant_id = $1 ORDER BY ts DESC LIMIT 500', [tenantId]);
      if (sRes.rows.length > 0) {
        sales = sRes.rows.map(r => ({
          id: r.id,
          billNo: r.bill_no,
          branch: r.branch,
          subtotal: Number(r.subtotal),
          tax: Number(r.tax),
          discount: Number(r.discount || 0),
          total: Number(r.total),
          payMethod: r.payment_method,
          items: r.items,
          customerName: r.customer_name,
          customerPhone: r.customer_phone,
          custName: r.customer_name,
          custPhone: r.customer_phone,
          cashier: r.cashier,
          ts: r.ts
        }));
        localDb.sales[tenantId] = sales;
      }

      const lRes = await pool.query('SELECT * FROM stock_logs WHERE tenant_id = $1 ORDER BY ts DESC LIMIT 500', [tenantId]);
      if (lRes.rows.length > 0) {
        stockLogs = lRes.rows.map(r => ({
          id: r.id,
          branch: r.branch,
          productName: r.product_name,
          change: Number(r.change),
          reason: r.reason,
          ts: r.ts
        }));
        localDb.stockLogs[tenantId] = stockLogs;
      }

      const tRes = await pool.query('SELECT * FROM transfers WHERE tenant_id = $1 ORDER BY ts DESC LIMIT 500', [tenantId]);
      if (tRes.rows.length > 0) {
        transfers = tRes.rows.map(r => ({
          id: r.id,
          productName: r.product_name,
          fromBranch: r.from_branch,
          toBranch: r.to_branch,
          qty: Number(r.qty),
          note: r.note,
          ts: r.ts
        }));
        localDb.transfers[tenantId] = transfers;
      }

      saveLocalData();
    } catch (e) {
      console.error('PG load data error:', e);
    }
  }

  return res.json({
    success: true,
    tenant: safePublicTenant(tenant),
    branches,
    products,
    sales,
    stockLogs,
    transfers
  });
});

function getTenantBranchesOrDefault(tenantId) {
  const t = localDb.tenants.find(x => x.id === tenantId);
  if (t) return ensureTenantBranches(t);
  return normalizeBranches({});
}

// Products CRUD for Tenant
app.post('/api/tenant/:tenantId/products', authRequired, requireTenantAccess, requireTenantAdmin, async (req, res) => {
  const { tenantId } = req.params;
  const branches = getTenantBranchesOrDefault(tenantId);
  const product = req.body || {};
  const newId = product.id || 'prod_' + uuidv4().slice(0, 8);
  const stock = product.stock && typeof product.stock === 'object'
    ? product.stock
    : getProductStockMap(product, branches.map(b => b.id));
  const item = normalizeProduct({ ...product, id: newId, stock }, branches);

  if (!localDb.products[tenantId]) localDb.products[tenantId] = [];
  localDb.products[tenantId].push(item);
  saveLocalData();
  await persistProductToPg(tenantId, item, branches);

  return res.json({ success: true, product: item });
});

app.put('/api/tenant/:tenantId/products/:id', authRequired, requireTenantAccess, requireTenantAdmin, async (req, res) => {
  const { tenantId, id } = req.params;
  const updates = req.body || {};
  const branches = getTenantBranchesOrDefault(tenantId);

  if (!localDb.products[tenantId]) localDb.products[tenantId] = [];
  let idx = localDb.products[tenantId].findIndex(p => p.id === id);
  let current = idx !== -1 ? localDb.products[tenantId][idx] : { id };

  // If only in PG, hydrate
  if (idx === -1 && pool) {
    try {
      const q = await pool.query('SELECT * FROM products WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
      if (q.rows[0]) {
        current = mapPgProductRow(q.rows[0], branches);
        localDb.products[tenantId].push(current);
        idx = localDb.products[tenantId].length - 1;
      }
    } catch (e) {}
  }

  const merged = normalizeProduct({ ...current, ...updates, id }, branches);
  if (updates.stock) {
    for (const [bid, qty] of Object.entries(updates.stock)) setStock(merged, bid, qty);
  }
  // legacy field updates
  for (const b of branches) {
    const legacyKey = b.id + 'Stock';
    if (updates[legacyKey] != null) setStock(merged, b.id, updates[legacyKey]);
  }

  if (idx === -1) localDb.products[tenantId].push(merged);
  else localDb.products[tenantId][idx] = merged;
  saveLocalData();
  await persistProductToPg(tenantId, merged, branches);

  return res.json({ success: true, product: merged });
});

app.delete('/api/tenant/:tenantId/products/:id', authRequired, requireTenantAccess, requireTenantAdmin, async (req, res) => {
  const { tenantId, id } = req.params;
  if (localDb.products[tenantId]) {
    localDb.products[tenantId] = localDb.products[tenantId].filter(p => p.id !== id);
    saveLocalData();
  }
  if (pool) {
    try {
      await pool.query('DELETE FROM products WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
    } catch (e) {
      console.error('Error deleting product from PG:', e);
    }
  }
  return res.json({ success: true });
});

// Complete Sale — write sale + decrement stock in BOTH stores
app.post('/api/tenant/:tenantId/sales', authRequired, requireTenantAccess, async (req, res) => {
  const { tenantId } = req.params;
  const sale = req.body || {};
  const branches = getTenantBranchesOrDefault(tenantId);
  const saleId = sale.id || 'sale_' + Date.now();
  const branchId = sale.branch || (branches[0] && branches[0].id) || 'b1';
  const newSale = {
    ...sale,
    id: saleId,
    branch: branchId,
    customerName: sale.customerName || sale.custName || '',
    customerPhone: sale.customerPhone || sale.custPhone || '',
    custName: sale.customerName || sale.custName || '',
    custPhone: sale.customerPhone || sale.custPhone || '',
    payMethod: sale.payMethod || sale.paymentMethod || 'cash',
    ts: new Date().toISOString()
  };

  if (!localDb.sales[tenantId]) localDb.sales[tenantId] = [];
  if (!localDb.products[tenantId]) localDb.products[tenantId] = [];
  localDb.sales[tenantId].unshift(newSale);

  const touched = [];
  if (Array.isArray(newSale.items)) {
    for (const cartItem of newSale.items) {
      const pid = cartItem.id || cartItem.productId;
      const prod = localDb.products[tenantId].find(p => p.id === pid);
      if (prod) {
        applyStockDelta(prod, branchId, -(cartItem.qty || 1));
        normalizeProduct(prod, branches);
        touched.push(prod);
      }
    }
  }
  saveLocalData();

  if (pool) {
    try {
      await pool.query(`
        INSERT INTO sales (id, tenant_id, bill_no, branch, subtotal, tax, discount, total, payment_method, items, customer_name, customer_phone, cashier)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (id) DO NOTHING
      `, [
        saleId, tenantId, newSale.billNo, newSale.branch, newSale.subtotal, newSale.tax,
        newSale.discount || 0, newSale.total, newSale.payMethod, JSON.stringify(newSale.items || []),
        newSale.customerName, newSale.customerPhone, newSale.cashier
      ]);
      for (const prod of touched) {
        await persistProductToPg(tenantId, prod, branches);
      }
    } catch (e) {
      console.error('Error saving sale in PG:', e);
    }
  }

  return res.json({ success: true, sale: newSale, products: touched });
});

// Stock Logs — dual write
app.post('/api/tenant/:tenantId/stock-log', authRequired, requireTenantAccess, requireTenantAdmin, async (req, res) => {
  const { tenantId } = req.params;
  const log = { id: 'log_' + Date.now(), ...req.body, ts: new Date().toISOString() };

  if (!localDb.stockLogs[tenantId]) localDb.stockLogs[tenantId] = [];
  localDb.stockLogs[tenantId].unshift(log);
  saveLocalData();

  if (pool) {
    try {
      await pool.query(`
        INSERT INTO stock_logs (id, tenant_id, branch, product_name, change, reason, ts)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO NOTHING
      `, [
        log.id, tenantId, log.branch || null, log.productName || log.product_name || '',
        log.change || 0, log.reason || '', log.ts
      ]);
    } catch (e) {
      console.error('Error saving stock log in PG:', e);
    }
  }

  return res.json({ success: true, log });
});

// Transfers — move stock + dual-write transfer row
app.post('/api/tenant/:tenantId/transfers', authRequired, requireTenantAccess, requireTenantAdmin, async (req, res) => {
  const { tenantId } = req.params;
  const body = req.body || {};
  const branches = getTenantBranchesOrDefault(tenantId);
  const fromBranch = body.fromBranch || body.from;
  const toBranch = body.toBranch || body.to;
  const qty = Number(body.qty || 0);
  const productId = body.productId || body.itemId;

  if (!fromBranch || !toBranch || fromBranch === toBranch) {
    return res.status(400).json({ error: 'fromBranch and toBranch are required and must differ' });
  }
  if (!productId || qty <= 0) {
    return res.status(400).json({ error: 'productId and positive qty required' });
  }

  if (!localDb.products[tenantId]) localDb.products[tenantId] = [];
  let prod = localDb.products[tenantId].find(p => p.id === productId);
  if (!prod && pool) {
    try {
      const q = await pool.query('SELECT * FROM products WHERE tenant_id = $1 AND id = $2', [tenantId, productId]);
      if (q.rows[0]) {
        prod = mapPgProductRow(q.rows[0], branches);
        localDb.products[tenantId].push(prod);
      }
    } catch (e) {}
  }
  if (!prod) return res.status(404).json({ error: 'Product not found' });

  const available = getStock(prod, fromBranch);
  if (available < qty) {
    return res.status(400).json({ error: `Insufficient stock at source (have ${available})` });
  }

  applyStockDelta(prod, fromBranch, -qty);
  applyStockDelta(prod, toBranch, qty);
  normalizeProduct(prod, branches);

  const transfer = {
    id: 'tr_' + Date.now(),
    productId: prod.id,
    productName: prod.name,
    fromBranch,
    toBranch,
    qty,
    note: body.note || '',
    ts: new Date().toISOString()
  };

  if (!localDb.transfers[tenantId]) localDb.transfers[tenantId] = [];
  localDb.transfers[tenantId].unshift(transfer);
  saveLocalData();

  if (pool) {
    try {
      await persistProductToPg(tenantId, prod, branches);
      await pool.query(`
        INSERT INTO transfers (id, tenant_id, product_name, from_branch, to_branch, qty, note, ts)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO NOTHING
      `, [
        transfer.id, tenantId, transfer.productName, transfer.fromBranch, transfer.toBranch,
        transfer.qty, transfer.note, transfer.ts
      ]);
    } catch (e) {
      console.error('Error saving transfer in PG:', e);
    }
  }

  return res.json({ success: true, transfer, product: prod });
});

// DB Health and Neon Configuration Status endpoint
app.get('/api/db-status', (req, res) => {
  res.json({
    isPostgresConnected: !!pool,
    databaseUrlSet: !!process.env.DATABASE_URL,
    totalTenants: localDb.tenants.length,
    storageType: pool ? 'Neon / PostgreSQL Cloud Database' : 'Isolated Multi-Tenant In-Memory / File Storage'
  });
});

// Provide full ready-to-run PostgreSQL schema script for Neon SQL Console
app.get('/api/neon-schema', authRequired, requireSuperAdmin, (req, res) => {
  const schemaSql = `-- OmniPOS Neon PostgreSQL Schema
-- Tables are automatically created and initialized by server.js on startup.
-- You can also run this script directly in the Neon SQL Editor console if desired.

CREATE TABLE IF NOT EXISTS tenants (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50) UNIQUE,
  username VARCHAR(100) UNIQUE,
  password VARCHAR(100),
  business_type VARCHAR(100),
  tagline TEXT,
  currency VARCHAR(10) DEFAULT '$',
  theme_color VARCHAR(50) DEFAULT '#c8860a',
  accent_color VARCHAR(50) DEFAULT '#3d1f0a',
  logo_url TEXT,
  gst_rate NUMERIC DEFAULT 5,
  b1name VARCHAR(100) DEFAULT 'Branch 1',
  b2name VARCHAR(100) DEFAULT 'Branch 2',
  b3name VARCHAR(100) DEFAULT 'Branch 3',
  pins JSONB DEFAULT '{"admin":"1234","b1":"1111","b2":"2222","b3":"3333"}',
  is_onboarded BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(100) PRIMARY KEY,
  tenant_id VARCHAR(100) REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  cat VARCHAR(100),
  price NUMERIC NOT NULL,
  cost NUMERIC DEFAULT 0,
  b1_stock NUMERIC DEFAULT 0,
  b2_stock NUMERIC DEFAULT 0,
  b3_stock NUMERIC DEFAULT 0,
  reorder NUMERIC DEFAULT 5,
  unit VARCHAR(50) DEFAULT 'pcs',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales (
  id VARCHAR(100) PRIMARY KEY,
  tenant_id VARCHAR(100) REFERENCES tenants(id) ON DELETE CASCADE,
  bill_no VARCHAR(100),
  branch VARCHAR(50),
  subtotal NUMERIC,
  tax NUMERIC,
  discount NUMERIC DEFAULT 0,
  total NUMERIC,
  payment_method VARCHAR(50),
  items JSONB,
  customer_name VARCHAR(100),
  customer_phone VARCHAR(50),
  cashier VARCHAR(100),
  ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_logs (
  id VARCHAR(100) PRIMARY KEY,
  tenant_id VARCHAR(100) REFERENCES tenants(id) ON DELETE CASCADE,
  branch VARCHAR(50),
  product_name VARCHAR(255),
  change NUMERIC,
  reason VARCHAR(255),
  ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transfers (
  id VARCHAR(100) PRIMARY KEY,
  tenant_id VARCHAR(100) REFERENCES tenants(id) ON DELETE CASCADE,
  product_name VARCHAR(255),
  from_branch VARCHAR(50),
  to_branch VARCHAR(50),
  qty NUMERIC,
  status VARCHAR(50) DEFAULT 'completed',
  ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sales_tenant ON sales(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stock_logs_tenant ON stock_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_transfers_tenant ON transfers(tenant_id);
`;
  res.setHeader('Content-Type', 'text/plain');
  res.send(schemaSql);
});

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Multi-tenant POS Platform running at http://0.0.0.0:${PORT}`);
});
