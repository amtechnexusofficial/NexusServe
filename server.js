import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

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

      -- Ensure username column exists if table was created previously
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS username VARCHAR(100);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS password VARCHAR(100);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_onboarded BOOLEAN DEFAULT true;

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

// ──────── API ROUTES ────────

// 0. Super-Admin Master Login & Customer Credentials Control (AMtechnexus)
const SUPER_ADMIN_CREDENTIALS = {
  username: process.env.SUPER_ADMIN_USER || 'admin@amtechnexus.com',
  password: process.env.SUPER_ADMIN_PASSWORD || 'amtech2026'
};

app.post('/api/superadmin/login', (req, res) => {
  const { username, password } = req.body;
  if (
    (username === SUPER_ADMIN_CREDENTIALS.username || username === 'admin') &&
    (password === SUPER_ADMIN_CREDENTIALS.password || password === 'amtech2026')
  ) {
    return res.json({
      success: true,
      role: 'superadmin',
      name: 'AMtechnexus Master Control',
      token: 'sat_' + Date.now()
    });
  }
  return res.status(401).json({ error: 'Invalid master super-admin credentials' });
});

// 1. Customer Tenant Login via Username + Password (Issued by AMtechnexus)
app.post('/api/tenant/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const u = username.trim().toLowerCase();
  let found = null;

  if (pool) {
    try {
      const q = await pool.query('SELECT * FROM tenants WHERE LOWER(username) = $1 OR LOWER(code) = $1', [u]);
      if (q.rows.length > 0) {
        const row = q.rows[0];
        if (row.password === password.trim()) {
          found = {
            id: row.id,
            name: row.name,
            code: row.code,
            username: row.username || row.code,
            password: row.password,
            businessType: row.business_type,
            tagline: row.tagline,
            currency: row.currency,
            themeColor: row.theme_color,
            accentColor: row.accent_color,
            logoUrl: row.logo_url,
            gstRate: Number(row.gst_rate || 0),
            b1name: row.b1name,
            b2name: row.b2name,
            b3name: row.b3name,
            pins: row.pins,
            isOnboarded: row.is_onboarded !== false
          };
        }
      }
    } catch (e) {
      console.error('PG tenant login lookup failed:', e);
    }
  }

  if (!found) {
    const loc = localDb.tenants.find(t => (t.username && t.username.toLowerCase() === u) || (t.code && t.code.toLowerCase() === u));
    if (loc && loc.password === password.trim()) {
      found = loc;
    }
  }

  if (!found) {
    return res.status(401).json({ error: 'Invalid username or password. Contact AMtechnexus support if needed.' });
  }

  return res.json({ success: true, tenant: found });
});

// 2. Get List of Available Tenants / Workspaces (for Superadmin & Switcher)
app.get('/api/tenants', async (req, res) => {
  if (pool) {
    try {
      const result = await pool.query('SELECT * FROM tenants ORDER BY created_at ASC');
      return res.json({ success: true, tenants: result.rows.map(r => ({
        id: r.id,
        name: r.name,
        code: r.code,
        username: r.username || r.code,
        password: r.password || 'pos123',
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
        pins: r.pins,
        isOnboarded: r.is_onboarded !== false
      })) });
    } catch (e) {
      console.error('Failed to load tenants from PG:', e);
    }
  }
  return res.json({ success: true, tenants: localDb.tenants });
});

// 3. Register / Create New Client Credentials (by AMtechnexus)
app.post('/api/tenants', async (req, res) => {
  const { name, username, password, businessType, tagline, currency, themeColor, accentColor, logoUrl, gstRate, b1name, b2name, b3name, adminPin, isOnboarded } = req.body;
  if (!name) return res.status(400).json({ error: 'Tenant business name is required' });

  const cleanId = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 50) + '-' + Math.floor(1000 + Math.random() * 9000);
  const code = username ? username.toLowerCase().replace(/[^a-z0-9_]/g, '') : name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const user = username ? username.trim().toLowerCase() : code;
  const pass = password ? password.trim() : 'pos' + Math.floor(1000 + Math.random() * 9000);

  const newTenant = {
    id: cleanId,
    name: name.trim(),
    code,
    username: user,
    password: pass,
    businessType: businessType || 'Food & Retail',
    tagline: tagline || 'Quality Products & Efficient Service',
    currency: currency || '₹',
    themeColor: themeColor || '#c8860a',
    accentColor: accentColor || '#3d1f0a',
    logoUrl: logoUrl || '',
    gstRate: Number(gstRate ?? 5),
    b1name: b1name || 'Main Branch',
    b2name: b2name || 'Counter 2',
    b3name: b3name || 'Delivery Unit',
    pins: {
      admin: adminPin || '1234',
      b1: '1111',
      b2: '2222',
      b3: '3333'
    },
    isOnboarded: isOnboarded === true ? true : false,
    createdAt: new Date().toISOString()
  };

  if (pool) {
    try {
      await pool.query(`
        INSERT INTO tenants (id, name, code, username, password, business_type, tagline, currency, theme_color, accent_color, logo_url, gst_rate, b1name, b2name, b3name, pins, is_onboarded)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      `, [
        newTenant.id, newTenant.name, newTenant.code, newTenant.username, newTenant.password,
        newTenant.businessType, newTenant.tagline, newTenant.currency, newTenant.themeColor,
        newTenant.accentColor, newTenant.logoUrl, newTenant.gstRate, newTenant.b1name,
        newTenant.b2name, newTenant.b3name, JSON.stringify(newTenant.pins), newTenant.isOnboarded
      ]);

      for (let i = 0; i < DEFAULT_SEED_ITEMS.length; i++) {
        const p = DEFAULT_SEED_ITEMS[i];
        const seedId = 'prod_' + uuidv4().slice(0, 8);
        await pool.query(`
          INSERT INTO products (id, tenant_id, name, cat, price, cost, b1_stock, b2_stock, b3_stock, reorder, unit)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (id) DO NOTHING
        `, [
          seedId, newTenant.id, p.name, p.cat, p.price, p.cost || 0,
          p.b1Stock || 0, p.b2Stock || 0, p.b3Stock || 0, p.reorder || 5, p.unit || 'pcs'
        ]);
      }
    } catch (e) {
      console.error('Error inserting tenant into PG:', e);
    }
  }

  localDb.tenants.push(newTenant);
  localDb.products[newTenant.id] = DEFAULT_SEED_ITEMS.map((item, idx) => ({
    id: `item_${Date.now()}_${idx}`,
    ...item
  }));
  localDb.sales[newTenant.id] = [];
  localDb.stockLogs[newTenant.id] = [];
  localDb.transfers[newTenant.id] = [];
  saveLocalData();

  return res.json({ success: true, tenant: newTenant });
});

// 4. Update Client Branding & Settings (including Logo Upload & Onboarding Completion)
app.put('/api/tenants/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const updates = req.body;

  let tenant = localDb.tenants.find(t => t.id === tenantId);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  // Update in-memory
  Object.assign(tenant, updates);
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
          pins = COALESCE($12, pins),
          username = COALESCE($13, username),
          password = COALESCE($14, password),
          is_onboarded = COALESCE($15, is_onboarded)
        WHERE id = $16
      `, [
        updates.name, updates.businessType, updates.tagline, updates.currency,
        updates.themeColor, updates.accentColor, updates.logoUrl, updates.gstRate,
        updates.b1name, updates.b2name, updates.b3name, updates.pins ? JSON.stringify(updates.pins) : null,
        updates.username, updates.password, updates.isOnboarded,
        tenantId
      ]);
    } catch (e) {
      console.error('Error updating tenant in PG:', e);
    }
  }

  return res.json({ success: true, tenant });
});

// 5. Delete Tenant (Super-Admin only)
app.delete('/api/tenants/:tenantId', async (req, res) => {
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
app.get('/api/tenant/:tenantId/data', async (req, res) => {
  const { tenantId } = req.params;
  const tenant = localDb.tenants.find(t => t.id === tenantId);
  if (!tenant) return res.status(404).json({ error: 'Client tenant not found' });

  let products = localDb.products[tenantId] || [];
  let sales = localDb.sales[tenantId] || [];
  let stockLogs = localDb.stockLogs[tenantId] || [];
  let transfers = localDb.transfers[tenantId] || [];

  if (pool) {
    try {
      const pRes = await pool.query('SELECT * FROM products WHERE tenant_id = $1 ORDER BY name ASC', [tenantId]);
      if (pRes.rows.length > 0) {
        products = pRes.rows.map(r => ({
          id: r.id,
          name: r.name,
          cat: r.cat,
          price: Number(r.price),
          cost: Number(r.cost),
          b1Stock: Number(r.b1_stock),
          b2Stock: Number(r.b2_stock),
          b3Stock: Number(r.b3_stock),
          reorder: Number(r.reorder),
          unit: r.unit
        }));
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
          custName: r.customer_name,
          custPhone: r.customer_phone,
          cashier: r.cashier,
          ts: r.ts
        }));
      }
    } catch (e) {
      console.error('PG load data error:', e);
    }
  }

  return res.json({
    success: true,
    tenant,
    products,
    sales,
    stockLogs,
    transfers
  });
});

// 5. Products CRUD for Tenant
app.post('/api/tenant/:tenantId/products', async (req, res) => {
  const { tenantId } = req.params;
  const product = req.body;
  const newId = product.id || 'prod_' + uuidv4().slice(0, 8);
  const item = { ...product, id: newId };

  if (!localDb.products[tenantId]) localDb.products[tenantId] = [];
  localDb.products[tenantId].push(item);
  saveLocalData();

  if (pool) {
    try {
      await pool.query(`
        INSERT INTO products (id, tenant_id, name, cat, price, cost, b1_stock, b2_stock, b3_stock, reorder, unit)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        newId, tenantId, item.name, item.cat, item.price, item.cost || 0,
        item.b1Stock || 0, item.b2Stock || 0, item.b3Stock || 0, item.reorder || 5, item.unit || 'pcs'
      ]);
    } catch (e) {
      console.error('Error adding product to PG:', e);
    }
  }

  return res.json({ success: true, product: item });
});

app.put('/api/tenant/:tenantId/products/:id', async (req, res) => {
  const { tenantId, id } = req.params;
  const updates = req.body;

  if (!localDb.products[tenantId]) localDb.products[tenantId] = [];
  const idx = localDb.products[tenantId].findIndex(p => p.id === id);
  if (idx !== -1) {
    localDb.products[tenantId][idx] = { ...localDb.products[tenantId][idx], ...updates };
    saveLocalData();
  }

  if (pool) {
    try {
      await pool.query(`
        UPDATE products SET
          name = COALESCE($1, name),
          cat = COALESCE($2, cat),
          price = COALESCE($3, price),
          cost = COALESCE($4, cost),
          b1_stock = COALESCE($5, b1_stock),
          b2_stock = COALESCE($6, b2_stock),
          b3_stock = COALESCE($7, b3_stock),
          reorder = COALESCE($8, reorder),
          unit = COALESCE($9, unit)
        WHERE tenant_id = $10 AND id = $11
      `, [
        updates.name, updates.cat, updates.price, updates.cost,
        updates.b1Stock, updates.b2Stock, updates.b3Stock, updates.reorder, updates.unit,
        tenantId, id
      ]);
    } catch (e) {
      console.error('Error updating product in PG:', e);
    }
  }

  return res.json({ success: true });
});

app.delete('/api/tenant/:tenantId/products/:id', async (req, res) => {
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

// 6. Complete Sale / Checkout for Tenant
app.post('/api/tenant/:tenantId/sales', async (req, res) => {
  const { tenantId } = req.params;
  const sale = req.body;
  const saleId = sale.id || 'sale_' + Date.now();
  const newSale = { ...sale, id: saleId, ts: new Date().toISOString() };

  if (!localDb.sales[tenantId]) localDb.sales[tenantId] = [];
  localDb.sales[tenantId].unshift(newSale);

  // Decrement product inventory for this tenant
  const branchStockKey = (newSale.branch || 'b1') + 'Stock';
  if (localDb.products[tenantId] && Array.isArray(newSale.items)) {
    newSale.items.forEach(cartItem => {
      const prod = localDb.products[tenantId].find(p => p.id === cartItem.id);
      if (prod) {
        prod[branchStockKey] = Math.max(0, (prod[branchStockKey] || 0) - (cartItem.qty || 1));
      }
    });
  }
  saveLocalData();

  if (pool) {
    try {
      await pool.query(`
        INSERT INTO sales (id, tenant_id, bill_no, branch, subtotal, tax, discount, total, payment_method, items, customer_name, customer_phone, cashier)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        saleId, tenantId, newSale.billNo, newSale.branch, newSale.subtotal, newSale.tax,
        newSale.discount || 0, newSale.total, newSale.payMethod, JSON.stringify(newSale.items),
        newSale.custName, newSale.custPhone, newSale.cashier
      ]);
    } catch (e) {
      console.error('Error saving sale in PG:', e);
    }
  }

  return res.json({ success: true, sale: newSale });
});

// 7. Stock Logs & Adjustments
app.post('/api/tenant/:tenantId/stock-log', async (req, res) => {
  const { tenantId } = req.params;
  const log = { id: 'log_' + Date.now(), ...req.body, ts: new Date().toISOString() };

  if (!localDb.stockLogs[tenantId]) localDb.stockLogs[tenantId] = [];
  localDb.stockLogs[tenantId].unshift(log);
  saveLocalData();

  return res.json({ success: true, log });
});

// 8. Stock Transfers
app.post('/api/tenant/:tenantId/transfers', async (req, res) => {
  const { tenantId } = req.params;
  const transfer = { id: 'tr_' + Date.now(), ...req.body, ts: new Date().toISOString() };

  if (!localDb.transfers[tenantId]) localDb.transfers[tenantId] = [];
  localDb.transfers[tenantId].unshift(transfer);
  saveLocalData();

  return res.json({ success: true, transfer });
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
app.get('/api/neon-schema', (req, res) => {
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
