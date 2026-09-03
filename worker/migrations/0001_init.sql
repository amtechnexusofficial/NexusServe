-- NexusServe D1 Schema

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT UNIQUE,
  username TEXT UNIQUE,
  password TEXT,
  business_type TEXT,
  tagline TEXT,
  currency TEXT DEFAULT '$',
  theme_color TEXT DEFAULT '#c8860a',
  accent_color TEXT DEFAULT '#3d1f0a',
  logo_url TEXT DEFAULT '',
  gst_rate REAL DEFAULT 5,
  b1name TEXT DEFAULT 'Branch 1',
  b2name TEXT DEFAULT 'Branch 2',
  b3name TEXT DEFAULT 'Branch 3',
  branches TEXT DEFAULT '[]',
  pins TEXT DEFAULT '{}',
  is_onboarded INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cat TEXT,
  price REAL NOT NULL,
  cost REAL DEFAULT 0,
  b1_stock REAL DEFAULT 0,
  b2_stock REAL DEFAULT 0,
  b3_stock REAL DEFAULT 0,
  stock TEXT DEFAULT '{}',
  reorder REAL DEFAULT 5,
  unit TEXT DEFAULT 'pcs',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  bill_no TEXT,
  branch TEXT,
  subtotal REAL,
  tax REAL,
  discount REAL DEFAULT 0,
  total REAL,
  payment_method TEXT,
  items TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  cashier TEXT,
  ts TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  branch TEXT,
  product_name TEXT,
  change REAL,
  reason TEXT,
  ts TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  product_name TEXT,
  from_branch TEXT,
  to_branch TEXT,
  qty REAL,
  note TEXT DEFAULT '',
  status TEXT DEFAULT 'completed',
  ts TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sales_tenant ON sales(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stock_logs_tenant ON stock_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_transfers_tenant ON transfers(tenant_id);
