-- NexusServe Neon / PostgreSQL Schema
-- Run once in the Neon SQL Editor console, or it auto-runs on Worker startup.

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
  logo_url TEXT DEFAULT '',
  gst_rate NUMERIC DEFAULT 5,
  b1name VARCHAR(100) DEFAULT 'Branch 1',
  b2name VARCHAR(100) DEFAULT 'Branch 2',
  b3name VARCHAR(100) DEFAULT 'Branch 3',
  branches JSONB DEFAULT '[]',
  pins JSONB DEFAULT '{}',
  is_onboarded BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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
  stock JSONB DEFAULT '{}',
  reorder NUMERIC DEFAULT 5,
  unit VARCHAR(50) DEFAULT 'pcs',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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
  ts TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_logs (
  id VARCHAR(100) PRIMARY KEY,
  tenant_id VARCHAR(100) REFERENCES tenants(id) ON DELETE CASCADE,
  branch VARCHAR(50),
  product_name VARCHAR(255),
  change NUMERIC,
  reason VARCHAR(255),
  ts TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transfers (
  id VARCHAR(100) PRIMARY KEY,
  tenant_id VARCHAR(100) REFERENCES tenants(id) ON DELETE CASCADE,
  product_name VARCHAR(255),
  from_branch VARCHAR(50),
  to_branch VARCHAR(50),
  qty NUMERIC,
  note TEXT DEFAULT '',
  status VARCHAR(50) DEFAULT 'completed',
  ts TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sales_tenant ON sales(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stock_logs_tenant ON stock_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_transfers_tenant ON transfers(tenant_id);

-- Safe upgrades if tables already exist from an older schema
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS branches JSONB;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS username VARCHAR(100);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS password VARCHAR(255);
ALTER TABLE tenants ALTER COLUMN password TYPE VARCHAR(255);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_onboarded BOOLEAN DEFAULT true;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_branches INTEGER DEFAULT 3;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock JSONB;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '';
