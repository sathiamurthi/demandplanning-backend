import { Pool, PoolClient } from 'pg';
import { logger } from './logger';

// ─────────────────────────────────────────────
// ENV CONFIG (Works for Local + Azure)
// ─────────────────────────────────────────────
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:admin@localhost:5432/dplaning';

if (!DATABASE_URL) {
  throw new Error('❌ DATABASE_URL is not defined');
}

// ─────────────────────────────────────────────
// CONNECTION POOL (Production Ready)
// ─────────────────────────────────────────────
export const pool = new Pool({
  connectionString: DATABASE_URL,

  max: 20, // max connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,

  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
});

// ─────────────────────────────────────────────
// POOL EVENTS (IMPORTANT FOR DEBUGGING)
// ─────────────────────────────────────────────
pool.on('connect', () => {
  logger.info('✅ PostgreSQL connected');
});

pool.on('error', (err) => {
  logger.error('❌ PostgreSQL pool error', {
    message: err.message,
    stack: err.stack,
  });
});

// ─────────────────────────────────────────────
// GENERIC QUERY (WITH LOGGING)
// ─────────────────────────────────────────────
export async function query<T = any>(
  sql: string,
  params: any[] = []
): Promise<T[]> {
  const start = Date.now();

  try {
    const result = await pool.query(sql, params);

    logger.debug('📊 DB Query', {
      sql,
      duration: `${Date.now() - start}ms`,
      rows: result.rowCount,
    });

    return result.rows as T[];
  } catch (err: any) {
    logger.error('❌ Query failed', {
      sql,
      error: err.message,
    });
    throw err;
  }
}

// ─────────────────────────────────────────────
// SINGLE ROW HELPER
// ─────────────────────────────────────────────
export async function queryOne<T = any>(
  sql: string,
  params: any[] = []
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────
// TENANT-SAFE QUERY (RLS SUPPORT)
// ─────────────────────────────────────────────
export async function queryWithTenant<T = any>(
  tenantId: string,
  sql: string,
  params: any[] = []
): Promise<T[]> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ✅ SAFE (prevents SQL injection)
    await client.query('SET LOCAL app.tenant_id = $1', [tenantId]);

    const result = await client.query(sql, params);

    await client.query('COMMIT');

    return result.rows as T[];
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('❌ Tenant query failed', { error: (err as any).message });
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────
// TRANSACTION WRAPPER
// ─────────────────────────────────────────────
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await fn(client);

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('❌ Transaction failed', { error: (err as any).message });
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────
// DB HEALTH CHECK
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// WAIT FOR DB (RETRY LOGIC - CRITICAL)
// ─────────────────────────────────────────────
export async function waitForDb(
  retries = 5,
  delayMs = 3000
): Promise<void> {
  for (let i = 1; i <= retries; i++) {
    const ok = await checkDbConnection();

    if (ok) {
      logger.info('🚀 Database ready');
      return;
    }

    logger.warn(`⏳ DB retry ${i}/${retries}...`);
    await new Promise((r) => setTimeout(r, delayMs));
  }

  throw new Error('❌ Database not reachable after retries');
}

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN (IMPORTANT FOR PROD)
// ─────────────────────────────────────────────
export async function closeDb(): Promise<void> {
  try {
    await pool.end();
    logger.info('🛑 PostgreSQL pool closed');
  } catch (err: any) {
    logger.error('❌ Error closing DB', { error: err.message });
  }
}

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    // Create migrations table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200) UNIQUE NOT NULL,
        run_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    logger.info('Running migrations for dplanning database...');

    const migrations = getMigrations();
    for (const m of migrations) {
      const exists = await client.query(
        'SELECT id FROM _migrations WHERE name = $1', [m.name]
      );
      if (exists.rows.length === 0) {
        logger.info(`Running migration: ${m.name}`);
        await client.query(m.sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [m.name]);
        logger.info(`Migration complete: ${m.name}`);
      }
    }
    logger.info('All migrations complete.');
  } finally {
    client.release();
  }
}

// ── Check DB connectivity ────────────────────────────────────
export async function checkDbConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// ── All migrations inline ────────────────────────────────────
function getMigrations() {
  return [
    {
      name: '001_extensions',
      sql: `
        CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
        CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      `
    },
    {
      name: '002_enums',
      sql: `
        DO $$ BEGIN
          CREATE TYPE user_role AS ENUM ('superadmin','industry_admin','owner','manager','staff');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN
          CREATE TYPE plan_type AS ENUM ('free','starter','growth','enterprise');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN
          CREATE TYPE billing_status AS ENUM ('active','past_due','suspended','cancelled','trial');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN
          CREATE TYPE invoice_status AS ENUM ('draft','issued','paid','overdue','void');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN
          CREATE TYPE order_status AS ENUM ('draft','sent','confirmed','delivered','cancelled');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN
          CREATE TYPE alert_type_enum AS ENUM ('low_stock','expiry','seasonal','reorder','overstock');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN
          CREATE TYPE alert_severity AS ENUM ('info','warning','critical');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN
          CREATE TYPE risk_level AS ENUM ('Low','Medium','High','Critical');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN
          CREATE TYPE sale_type AS ENUM ('individual','bulk','return','adjustment');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      `
    },
    {
      name: '003_unit_types',
      sql: `
        CREATE TABLE IF NOT EXISTS unit_types (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          name VARCHAR(50) NOT NULL,
          symbol VARCHAR(20) NOT NULL,
          category VARCHAR(20) NOT NULL DEFAULT 'count',
          base_unit_id UUID REFERENCES unit_types(id),
          conversion_factor DECIMAL(18,6) DEFAULT 1.0,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(name), UNIQUE(symbol)
        );
        INSERT INTO unit_types (name, symbol, category) VALUES
          ('Piece','pc','count'),('Dozen','doz','count'),('Strip','strip','count'),
          ('Box','box','count'),('Carton','ctn','count'),('Pack','pack','count'),
          ('Kilogram','kg','weight'),('Gram','g','weight'),('Milligram','mg','weight'),
          ('Tonne','tn','weight'),('Litre','L','volume'),('Millilitre','mL','volume'),
          ('Metre','m','length'),('Centimetre','cm','length')
        ON CONFLICT DO NOTHING;
      `
    },
    {
      name: '004_industry_configs',
      sql: `
        CREATE TABLE IF NOT EXISTS industry_configs (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          industry_id VARCHAR(50) UNIQUE NOT NULL,
          display_name VARCHAR(100) NOT NULL,
          item_noun VARCHAR(50) NOT NULL,
          default_unit_symbol VARCHAR(20) NOT NULL,
          domain_keywords TEXT[] NOT NULL DEFAULT '{}',
          off_topic_keywords TEXT[] NOT NULL DEFAULT '{}',
          seasonal_signals TEXT[] NOT NULL DEFAULT '{}',
          prompt_context TEXT NOT NULL,
          low_stock_days INT NOT NULL DEFAULT 5,
          expiry_warn_days INT NOT NULL DEFAULT 30,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        INSERT INTO industry_configs (industry_id,display_name,item_noun,default_unit_symbol,domain_keywords,off_topic_keywords,seasonal_signals,prompt_context,low_stock_days,expiry_warn_days) VALUES
          ('pharma','Pharmacy','Medicine','strip',ARRAY['medicine','tablet','syrup','injection','capsule','drug','dosage'],ARRAY['food','fuel','clothing'],ARRAY['monsoon','winter','summer'],'expert pharmacy demand planner with knowledge of drug expiry and seasonal illness trends',3,30),
          ('restaurant','Restaurant','Ingredient','kg',ARRAY['ingredient','recipe','kitchen','food','beverage','spice'],ARRAY['medicine','fuel','auto'],ARRAY['festival','summer','winter'],'restaurant supply chain expert optimizing ingredient freshness and waste reduction',1,2),
          ('retail','Retail Store','Product','pc',ARRAY['product','sku','retail','merchandise','apparel','electronics'],ARRAY['medicine','food','fuel'],ARRAY['festive','back-to-school','summer'],'retail demand planner with expertise in seasonal trends and promotional events',5,60),
          ('grocery','Grocery Store','Item','pack',ARRAY['grocery','staple','fmcg','packaged','food','daily'],ARRAY['medicine','auto','fuel'],ARRAY['harvest','festival','summer'],'grocery store inventory expert focused on FMCG turnover and freshness',2,5),
          ('auto','Auto Parts','Part','pc',ARRAY['part','spare','auto','vehicle','engine','oil','filter'],ARRAY['food','medicine','clothing'],ARRAY['monsoon','summer'],'automotive parts demand expert with knowledge of vehicle service cycles',7,365),
          ('kirana','Kirana Store','Item','pack',ARRAY['kirana','grocery','staple','daily','household','fmcg'],ARRAY['medicine','auto','fuel'],ARRAY['festival','summer'],'kirana store demand expert for Indian neighborhood retail',2,7)
        ON CONFLICT DO NOTHING;
      `
    },
    {
      name: '005_billing_plans',
      sql: `
        CREATE TABLE IF NOT EXISTS billing_plans (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          plan_type plan_type UNIQUE NOT NULL,
          display_name VARCHAR(100) NOT NULL,
          price_monthly_inr DECIMAL(10,2) NOT NULL DEFAULT 0,
          price_yearly_inr DECIMAL(10,2) NOT NULL DEFAULT 0,
          max_stores INT NOT NULL DEFAULT 1,
          max_users INT NOT NULL DEFAULT 2,
          max_items_per_store INT NOT NULL DEFAULT 100,
          ai_reports_per_month INT NOT NULL DEFAULT 10,
          whatsapp_alerts BOOLEAN DEFAULT FALSE,
          api_access BOOLEAN DEFAULT FALSE,
          custom_industry BOOLEAN DEFAULT FALSE,
          sso_enabled BOOLEAN DEFAULT FALSE,
          audit_log BOOLEAN DEFAULT FALSE,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        INSERT INTO billing_plans (plan_type,display_name,price_monthly_inr,price_yearly_inr,max_stores,max_users,max_items_per_store,ai_reports_per_month,whatsapp_alerts,api_access,custom_industry,sso_enabled,audit_log) VALUES
          ('free','Free',0,0,1,2,50,5,FALSE,FALSE,FALSE,FALSE,FALSE),
          ('starter','Starter',999,9990,2,5,500,30,FALSE,FALSE,FALSE,FALSE,FALSE),
          ('growth','Growth',2999,29990,10,20,2000,100,TRUE,TRUE,FALSE,FALSE,TRUE),
          ('enterprise','Enterprise',9999,99990,-1,-1,-1,-1,TRUE,TRUE,TRUE,TRUE,TRUE)
        ON CONFLICT DO NOTHING;
      `
    },
    {
  name: '005A_tenant_slug_fix',
  sql: `
    CREATE OR REPLACE FUNCTION generate_slug(input TEXT)
    RETURNS TEXT AS $$
    BEGIN
      RETURN lower(regexp_replace(input, '[^a-zA-Z0-9]+', '-', 'g'));
    END;
    $$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION set_tenant_slug()
    RETURNS TRIGGER AS $$
    DECLARE
      base_slug TEXT;
      final_slug TEXT;
      counter INT := 1;
    BEGIN
      IF NEW.slug IS NULL OR NEW.slug = '' THEN
        base_slug := generate_slug(NEW.name);
      ELSE
        base_slug := generate_slug(NEW.slug);
      END IF;

      final_slug := base_slug;

      WHILE EXISTS (
        SELECT 1 FROM tenants
        WHERE slug = final_slug
        AND (TG_OP = 'INSERT' OR id <> NEW.id)
      ) LOOP
        final_slug := base_slug || '-' || counter;
        counter := counter + 1;
      END LOOP;

      NEW.slug := final_slug;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `
},
    {
      name: '006_tenants',
      sql: `
        CREATE TABLE IF NOT EXISTS tenants (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          name VARCHAR(200) NOT NULL,
          slug VARCHAR(100) UNIQUE ,
          industry_id VARCHAR(50),
          plan_type plan_type NOT NULL DEFAULT 'free',
          billing_status billing_status NOT NULL DEFAULT 'trial',
          trial_ends_at TIMESTAMPTZ,
          billing_email VARCHAR(254),
          billing_phone VARCHAR(20),
          gst_number VARCHAR(20),
          pan_number VARCHAR(20),
          address TEXT,
          city VARCHAR(100),
          state VARCHAR(100),
          pincode VARCHAR(10),
          country VARCHAR(50) DEFAULT 'India',
          logo_url TEXT,
          timezone VARCHAR(50) DEFAULT 'Asia/Kolkata',
          currency VARCHAR(10) DEFAULT 'INR',
          metadata JSONB DEFAULT '{}',
          is_active BOOLEAN DEFAULT TRUE,
          created_by UUID,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        DROP TRIGGER IF EXISTS trg_set_tenant_slug ON tenants;

        CREATE TRIGGER trg_set_tenant_slug
        BEFORE INSERT OR UPDATE ON tenants
        FOR EACH ROW
        EXECUTE FUNCTION set_tenant_slug();
      `
    },
    {
      name: '006B_fix_existing_slugs',
      sql: `
        UPDATE tenants
        SET slug = generate_slug(name)
        WHERE slug IS NULL OR slug = '';
      `
    },
    {
      name: '006C_enforce_slug_not_null',
      sql: `
        ALTER TABLE tenants
        ALTER COLUMN slug SET NOT NULL;
      `
    },
    {
      name: '007_tenant_subscriptions',
      sql: `
        CREATE TABLE IF NOT EXISTS tenant_subscriptions (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          plan_type plan_type NOT NULL,
          billing_cycle VARCHAR(20) DEFAULT 'monthly',
          amount_inr DECIMAL(10,2) NOT NULL,
          starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ends_at TIMESTAMPTZ,
          renews_at TIMESTAMPTZ,
          cancelled_at TIMESTAMPTZ,
          payment_method VARCHAR(50),
          external_sub_id VARCHAR(200),
          is_current BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE SEQUENCE IF NOT EXISTS invoice_seq START 1;
        CREATE TABLE IF NOT EXISTS invoices (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          invoice_number VARCHAR(50) UNIQUE NOT NULL DEFAULT ('INV-' || to_char(NOW(),'YYYY') || '-' || lpad(nextval('invoice_seq')::text,5,'0')),
          tenant_id UUID NOT NULL REFERENCES tenants(id),
          subscription_id UUID REFERENCES tenant_subscriptions(id),
          plan_type plan_type NOT NULL,
          billing_period_from TIMESTAMPTZ NOT NULL,
          billing_period_to TIMESTAMPTZ NOT NULL,
          subtotal_inr DECIMAL(10,2) NOT NULL,
          gst_rate DECIMAL(5,2) DEFAULT 18.00,
          gst_amount_inr DECIMAL(10,2) NOT NULL,
          total_inr DECIMAL(10,2) NOT NULL,
          status invoice_status DEFAULT 'draft',
          issued_at TIMESTAMPTZ,
          due_at TIMESTAMPTZ,
          paid_at TIMESTAMPTZ,
          payment_ref VARCHAR(200),
          notes TEXT,
          line_items JSONB DEFAULT '[]',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `
    },
    {
      name: '008_users',
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
          store_id UUID,
          email VARCHAR(254) UNIQUE NOT NULL,
          password_hash VARCHAR(255),
          role user_role NOT NULL DEFAULT 'staff',
          first_name VARCHAR(100),
          last_name VARCHAR(100),
          phone VARCHAR(20),
          avatar_url TEXT,
          is_active BOOLEAN DEFAULT TRUE,
          is_email_verified BOOLEAN DEFAULT FALSE,
          last_login_at TIMESTAMPTZ,
          login_count INT DEFAULT 0,
          failed_login_count INT DEFAULT 0,
          locked_until TIMESTAMPTZ,
          preferences JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS user_sessions (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          refresh_token_hash VARCHAR(255) NOT NULL,
          ip_address INET,
          user_agent TEXT,
          expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        -- Superadmin seed
        INSERT INTO users (email, role, first_name, last_name, is_active, is_email_verified,
          password_hash)
        VALUES ('superadmin@genericdemandai.com','superadmin','Super','Admin',TRUE,TRUE,
          '$2b$10$laSPM4SB2UALjDFzJnjUS.Hx5MX.of2eh0TYA09WIcCtvLtHHATg.') -- password: Admin@123
        ON CONFLICT DO NOTHING;
      `
    },
    {
      name: '009_stores',
      sql: `
        CREATE TABLE IF NOT EXISTS stores (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          name VARCHAR(200) NOT NULL,
          code VARCHAR(20),
          owner_name VARCHAR(200),
          email VARCHAR(254),
          phone VARCHAR(20),
          address TEXT,
          city VARCHAR(100),
          state VARCHAR(100),
          pincode VARCHAR(10),
          gst_number VARCHAR(20),
          is_active BOOLEAN DEFAULT TRUE,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        ALTER TABLE users ADD COLUMN IF NOT EXISTS store_id_fk UUID REFERENCES stores(id);
      `
    },
    
    {
      name: '010_categories_suppliers',
      sql: `
        CREATE TABLE IF NOT EXISTS categories (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id),
          parent_id UUID REFERENCES categories(id),
          name VARCHAR(100) NOT NULL,
          code VARCHAR(50),
          description TEXT,
          is_active BOOLEAN DEFAULT TRUE,
          sort_order INT DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(tenant_id, name)
        );
        CREATE TABLE IF NOT EXISTS suppliers (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id),
          name VARCHAR(200) NOT NULL,
          contact_name VARCHAR(200),
          email VARCHAR(254),
          phone VARCHAR(20),
          address TEXT,
          gst_number VARCHAR(20),
          payment_terms_days INT DEFAULT 30,
          lead_time_days INT DEFAULT 5,
          rating DECIMAL(3,1),
          is_active BOOLEAN DEFAULT TRUE,
          notes TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `
    },
    {
      name: '011_items',
      sql: `
        CREATE TABLE IF NOT EXISTS items (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
          tenant_id UUID NOT NULL REFERENCES tenants(id),
          category_id UUID REFERENCES categories(id),
          supplier_id UUID REFERENCES suppliers(id),
          name VARCHAR(300) NOT NULL,
          sku VARCHAR(100),
          barcode VARCHAR(100),
          brand VARCHAR(200),
          description TEXT,
          current_stock DECIMAL(18,4) NOT NULL DEFAULT 0,
          reserved_stock DECIMAL(18,4) NOT NULL DEFAULT 0,
          reorder_level DECIMAL(18,4) NOT NULL DEFAULT 10,
          max_stock_level DECIMAL(18,4),
          lead_time_days INT DEFAULT 4,
          primary_unit_id UUID REFERENCES unit_types(id),
          secondary_unit_id UUID REFERENCES unit_types(id),
          units_per_secondary DECIMAL(18,4),
          purchase_price DECIMAL(10,2),
          selling_price DECIMAL(10,2),
          mrp DECIMAL(10,2),
          gst_rate DECIMAL(5,2) DEFAULT 0,
          expiry_date DATE,
          manufacture_date DATE,
          batch_number VARCHAR(100),
          season_flag VARCHAR(50),
          is_seasonal BOOLEAN DEFAULT FALSE,
          monthly_usage_avg DECIMAL(18,4) DEFAULT 0,
          discount_type VARCHAR(50) DEFAULT 'none',
          discount_value DECIMAL(10,2) DEFAULT 0,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_items_store ON items(store_id);
        CREATE INDEX IF NOT EXISTS idx_items_tenant ON items(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_items_sku ON items(sku) WHERE sku IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_items_expiry ON items(expiry_date) WHERE expiry_date IS NOT NULL;
        CREATE TABLE IF NOT EXISTS stock_ledger (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          item_id UUID NOT NULL REFERENCES items(id),
          store_id UUID NOT NULL REFERENCES stores(id),
          tenant_id UUID NOT NULL REFERENCES tenants(id),
          movement_type VARCHAR(50) NOT NULL,
          reference_id UUID,
          reference_type VARCHAR(50),
          qty_before DECIMAL(18,4) NOT NULL,
          qty_change DECIMAL(18,4) NOT NULL,
          qty_after DECIMAL(18,4) NOT NULL,
          unit_id UUID REFERENCES unit_types(id),
          unit_price DECIMAL(10,2),
          notes TEXT,
          created_by UUID REFERENCES users(id),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_item ON stock_ledger(item_id, created_at DESC);
      `
    },
    {
      name: '012_sales',
      sql: `
        CREATE TABLE IF NOT EXISTS sales (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          store_id UUID NOT NULL REFERENCES stores(id),
          tenant_id UUID NOT NULL REFERENCES tenants(id),
          sale_number VARCHAR(50),
          sale_type sale_type NOT NULL DEFAULT 'individual',
          sale_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          customer_name VARCHAR(200),
          customer_phone VARCHAR(20),
          customer_email VARCHAR(254),
          subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
          discount_amount DECIMAL(12,2) DEFAULT 0,
          gst_amount DECIMAL(12,2) DEFAULT 0,
          total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
          payment_method VARCHAR(50),
          notes TEXT,
          created_by UUID REFERENCES users(id),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS sale_items (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
          item_id UUID NOT NULL REFERENCES items(id),
          qty_sold DECIMAL(18,4) NOT NULL,
          unit_id UUID REFERENCES unit_types(id),
          unit_price DECIMAL(10,2) NOT NULL,
          discount_pct DECIMAL(5,2) DEFAULT 0,
          discount_amount DECIMAL(10,2) DEFAULT 0,
          gst_rate DECIMAL(5,2) DEFAULT 0,
          gst_amount DECIMAL(10,2) DEFAULT 0,
          line_total DECIMAL(12,2) NOT NULL,
          batch_number VARCHAR(100),
          expiry_date DATE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS bulk_sale_batches (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          store_id UUID NOT NULL REFERENCES stores(id),
          tenant_id UUID NOT NULL REFERENCES tenants(id),
          batch_ref VARCHAR(100),
          buyer_name VARCHAR(200),
          buyer_gst VARCHAR(20),
          sale_ids UUID[] NOT NULL DEFAULT '{}',
          total_items INT DEFAULT 0,
          total_qty DECIMAL(18,4) DEFAULT 0,
          total_amount DECIMAL(12,2) DEFAULT 0,
          notes TEXT,
          created_by UUID REFERENCES users(id),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_sales_store ON sales(store_id, sale_date DESC);
        CREATE INDEX IF NOT EXISTS idx_sales_tenant ON sales(tenant_id, sale_date DESC);
      `
    },
    {
      name: '013_purchase_orders',
      sql: `
        CREATE TABLE IF NOT EXISTS purchase_orders (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          store_id UUID NOT NULL REFERENCES stores(id),
          tenant_id UUID NOT NULL REFERENCES tenants(id),
          supplier_id UUID REFERENCES suppliers(id),
          order_number VARCHAR(50),
          order_date TIMESTAMPTZ DEFAULT NOW(),
          expected_delivery DATE,
          actual_delivery DATE,
          status order_status DEFAULT 'draft',
          subtotal DECIMAL(12,2) DEFAULT 0,
          gst_amount DECIMAL(12,2) DEFAULT 0,
          total_amount DECIMAL(12,2) DEFAULT 0,
          ai_generated BOOLEAN DEFAULT FALSE,
          approved_by UUID REFERENCES users(id),
          approved_at TIMESTAMPTZ,
          notes TEXT,
          created_by UUID REFERENCES users(id),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS purchase_order_items (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
          item_id UUID NOT NULL REFERENCES items(id),
          qty_ordered DECIMAL(18,4) NOT NULL,
          qty_received DECIMAL(18,4) DEFAULT 0,
          unit_id UUID REFERENCES unit_types(id),
          unit_price DECIMAL(10,2),
          gst_rate DECIMAL(5,2) DEFAULT 0,
          line_total DECIMAL(12,2),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `
    },
    {
      name: '014_ai_forecasts_alerts',
      sql: `
        CREATE TABLE IF NOT EXISTS ai_forecasts (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          store_id UUID NOT NULL REFERENCES stores(id),
          tenant_id UUID NOT NULL REFERENCES tenants(id),
          item_id UUID REFERENCES items(id),
          predicted_qty_30d DECIMAL(18,4) NOT NULL,
          confidence_pct INT NOT NULL,
          order_needed BOOLEAN DEFAULT FALSE,
          order_qty DECIMAL(18,4) DEFAULT 0,
          risk_level risk_level NOT NULL DEFAULT 'Low',
          reasoning TEXT,
          notify_email VARCHAR(254),
          industry_id VARCHAR(50) NOT NULL,
          model_version VARCHAR(100) DEFAULT 'claude-sonnet-4-20250514',
          prompt_tokens INT,
          completion_tokens INT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS ai_alerts (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          store_id UUID NOT NULL REFERENCES stores(id),
          tenant_id UUID NOT NULL REFERENCES tenants(id),
          item_id UUID REFERENCES items(id),
          alert_type alert_type_enum NOT NULL,
          message TEXT NOT NULL,
          severity alert_severity NOT NULL DEFAULT 'info',
          is_read BOOLEAN DEFAULT FALSE,
          read_by UUID REFERENCES users(id),
          read_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_alerts_store_unread ON ai_alerts(store_id, is_read) WHERE is_read = FALSE;
        CREATE TABLE IF NOT EXISTS tenant_usage (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id),
          month DATE NOT NULL,
          ai_reports_used INT DEFAULT 0,
          whatsapp_sent INT DEFAULT 0,
          api_calls INT DEFAULT 0,
          active_stores INT DEFAULT 0,
          active_users INT DEFAULT 0,
          total_items INT DEFAULT 0,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(tenant_id, month)
        );
      `
    },
    {
      name: '015_audit_logs',
      sql: `
        CREATE TABLE IF NOT EXISTS audit_logs (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID REFERENCES tenants(id),
          user_id UUID REFERENCES users(id),
          action VARCHAR(100) NOT NULL,
          resource_type VARCHAR(50),
          resource_id UUID,
          old_value JSONB,
          new_value JSONB,
          ip_address INET,
          user_agent TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id, created_at DESC);
      `
    },
    {
  name: '015_store_config',
  sql: `
    CREATE TABLE IF NOT EXISTS store_config (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      industry VARCHAR(50) UNIQUE NOT NULL, -- pharma, restaurant, grocery, retail, autoparts
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Stores reference config
    ALTER TABLE stores
      ADD COLUMN IF NOT EXISTS config_id UUID REFERENCES store_config(id) ON DELETE SET NULL;
      -- Pharma
INSERT INTO store_config (industry, description, metadata)
VALUES ('pharma', 'Pharmaceutical stores and pharmacies', '{"requires_gst": true}') ON CONFLICT (industry) DO NOTHING;;

-- Restaurant
INSERT INTO store_config (industry, description, metadata)
VALUES ('restaurant', 'Restaurants, cafes, and food outlets', '{"requires_fssai": true}') ON CONFLICT (industry) DO NOTHING;;

-- Grocery
INSERT INTO store_config (industry, description, metadata)
VALUES ('grocery', 'Grocery and supermarkets', '{"requires_gst": true}') ON CONFLICT (industry) DO NOTHING;;

-- Retail
INSERT INTO store_config (industry, description, metadata)
VALUES ('retail', 'General retail stores', '{"requires_gst": true}') ON CONFLICT (industry) DO NOTHING;;

-- Auto Parts
INSERT INTO store_config (industry, description, metadata)
VALUES ('autoparts', 'Automobile parts and service stores', '{"requires_gst": true}') ON CONFLICT (industry) DO NOTHING;;

  `
},

{
  name: '017_refresh_tokens',
  sql: `
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT unique_user_refresh UNIQUE (user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);
  `,
},
{
  name: '018_pharma_seed',
  sql: `
    -- ============================================================
    -- PHARMACY TENANT DATA SEED
    -- ============================================================

    DO $$
DECLARE
  v_tenant_id UUID := '8577ae94-609a-4bc6-b29b-5f9cef2a6b94';
  v_store_id UUID := '11111111-1111-1111-1111-111111111111';
  v_unit_strip UUID;
BEGIN

  -- ✅ Get unit id safely
  SELECT id INTO v_unit_strip FROM unit_types WHERE symbol = 'strip' LIMIT 1;

  -- =========================================================
  -- TENANT (FIXED: slug, industry_id, etc.)
  -- =========================================================
  INSERT INTO tenants (
  id, name, slug, industry_id, plan_type, billing_status
)
VALUES (
  v_tenant_id,
  'Pharma Tenant',
  'pharma-tenant',
  (SELECT id FROM industry_configs WHERE industry_id = 'pharma'),
  'free',
  'trial'
)
ON CONFLICT DO NOTHING;

  -- =========================================================
  -- STORE
  -- =========================================================
  INSERT INTO stores (id, tenant_id, name, created_at)
  VALUES (v_store_id, v_tenant_id, 'Main Store', NOW())
  ON CONFLICT (id) DO NOTHING;

  -- =========================================================
  -- ITEMS (FIXED primary_unit_id)
  -- =========================================================
  INSERT INTO items (
    id, store_id, tenant_id, name,
    current_stock, reserved_stock,
    reorder_level, max_stock_level,
    primary_unit_id
  )
  VALUES
    (uuid_generate_v4(), v_store_id, v_tenant_id, 'Paracetamol 500mg', 50, 5, 10, 200, v_unit_strip),
    (uuid_generate_v4(), v_store_id, v_tenant_id, 'Ibuprofen 200mg', 0, 0, 20, 150, v_unit_strip),
    (uuid_generate_v4(), v_store_id, v_tenant_id, 'Vitamin C Tablets', 300, 0, 50, 250, v_unit_strip),
    (uuid_generate_v4(), v_store_id, v_tenant_id, 'Amoxicillin Capsules', 5, 0, 15, 100, v_unit_strip)
  ON CONFLICT DO NOTHING;

  -- =========================================================
  -- SALES (FIXED store_id NULL issue)
  -- =========================================================
  INSERT INTO sales (id, store_id, tenant_id, sale_date)
  VALUES
    ('33333333-3333-3333-3333-333333333333', v_store_id, v_tenant_id, NOW() - INTERVAL '2 days'),
    ('44444444-4444-4444-4444-444444444444', v_store_id, v_tenant_id, NOW() - INTERVAL '1 day')
  ON CONFLICT DO NOTHING;

  -- =========================================================
  -- SALE ITEMS
  -- =========================================================
  INSERT INTO sale_items (sale_id, item_id, qty_sold, unit_id, unit_price, line_total)
  SELECT
    '33333333-3333-3333-3333-333333333333',
    id,
    10,
    primary_unit_id,
    5.00,
    50.00
  FROM items WHERE name = 'Paracetamol 500mg'
  LIMIT 1;

  INSERT INTO sale_items (sale_id, item_id, qty_sold, unit_id, unit_price, line_total)
  SELECT
    '44444444-4444-4444-4444-444444444444',
    id,
    20,
    primary_unit_id,
    8.00,
    160.00
  FROM items WHERE name = 'Vitamin C Tablets'
  LIMIT 1;

  -- =========================================================
  -- AI ALERTS (FIXED schema)
  -- =========================================================
  INSERT INTO ai_alerts (
    id, store_id, tenant_id, message, alert_type, severity, created_at
  )
  VALUES
    (uuid_generate_v4(), v_store_id, v_tenant_id, 'Critical stock: Ibuprofen out of stock', 'low_stock', 'critical', NOW()),
    (uuid_generate_v4(), v_store_id, v_tenant_id, 'Low stock: Amoxicillin nearing reorder', 'low_stock', 'warning', NOW());

  -- =========================================================
  -- AI FORECASTS (FIXED column names)
  -- =========================================================
  INSERT INTO ai_forecasts (
    id, store_id, tenant_id, item_id,
    predicted_qty_30d, confidence_pct,
    order_needed, order_qty, risk_level,
    reasoning, industry_id, created_at
  )
  SELECT
    uuid_generate_v4(),
    v_store_id,
    v_tenant_id,
    id,
    120,
    85,
    TRUE,
    100,
    'Medium',
    'Seasonal demand expected',
    'pharma',
    NOW()
  FROM items WHERE name = 'Vitamin C Tablets'
  LIMIT 1;

END $$;
  `
},
{
  name: '019_dashboard_seed_with_stores',
  sql: `
    INSERT INTO tenants (
  id,
  name,
  slug,
  industry_id,
  plan_type,
  billing_status
)
VALUES (
  '8577ae94-609a-4bc6-b29b-5f9cef2a6b94',
  'Pharma Tenant',
  'pharma-tenant',
  (SELECT id FROM industry_configs WHERE industry_id = 'pharma'),
  'free',
  'trial'
)
ON CONFLICT DO NOTHING;
  `,
}
,
{
  name: '020_sales_and_saleitmes_seed',
  sql: `
  -- Sale 1: Paracetamol + Vitamin C
WITH store AS (
  SELECT id FROM stores WHERE tenant_id = '8577ae94-609a-4bc6-b29b-5f9cef2a6b94' AND name = 'Apollo Pharmacy BLR'
),
sale AS (
  INSERT INTO sales (id, tenant_id, store_id, sale_date, total_amount, created_at)
  SELECT gen_random_uuid(), '8577ae94-609a-4bc6-b29b-5f9cef2a6b94', store.id, CURRENT_DATE - INTERVAL '2 days', 250.00, NOW()
  FROM store
  RETURNING id
)
INSERT INTO sale_items (id, sale_id, item_id, qty_sold, unit_price, line_total, created_at)
SELECT gen_random_uuid(), sale.id, i.id, qty, price, qty*price, NOW()
FROM sale
JOIN items i ON i.tenant_id = '8577ae94-609a-4bc6-b29b-5f9cef2a6b94' AND i.name IN ('Paracetamol 500mg','Vitamin C Tablets')
JOIN (VALUES ('Paracetamol 500mg',5,20.00), ('Vitamin C Tablets',3,50.00)) v(name,qty,price) ON i.name = v.name;

-- Sale 2: Azithromycin
WITH store AS (
  SELECT id FROM stores WHERE tenant_id = '8577ae94-609a-4bc6-b29b-5f9cef2a6b94' AND name = 'Apollo Pharmacy BLR'
),
sale AS (
  INSERT INTO sales (id, tenant_id, store_id, sale_date, total_amount, created_at)
  SELECT gen_random_uuid(), '8577ae94-609a-4bc6-b29b-5f9cef2a6b94', store.id, CURRENT_DATE - INTERVAL '1 day', 180.00, NOW()
  FROM store
  RETURNING id
)
INSERT INTO sale_items (id, sale_id, item_id, qty_sold, unit_price, line_total, created_at)
SELECT gen_random_uuid(), sale.id, i.id, 2, 90.00, 180.00, NOW()
FROM sale
JOIN items i ON i.tenant_id = '8577ae94-609a-4bc6-b29b-5f9cef2a6b94' AND i.name = 'Azithromycin 250mg';

-- Sale 3: Cough Syrup
WITH store AS (
  SELECT id FROM stores WHERE tenant_id = '8577ae94-609a-4bc6-b29b-5f9cef2a6b94' AND name = 'Apollo Pharmacy BLR'
),
sale AS (
  INSERT INTO sales (id, tenant_id, store_id, sale_date, total_amount, created_at)
  SELECT gen_random_uuid(), '8577ae94-609a-4bc6-b29b-5f9cef2a6b94', store.id, CURRENT_DATE, 120.00, NOW()
  FROM store
  RETURNING id
)
INSERT INTO sale_items (id, sale_id, item_id, qty_sold, unit_price, line_total, created_at)
SELECT gen_random_uuid(), sale.id, i.id, 4, 30.00, 120.00, NOW()
FROM sale
JOIN items i ON i.tenant_id = '8577ae94-609a-4bc6-b29b-5f9cef2a6b94' AND i.name = 'Cough Syrup';

  `
},
 
    {
      name: '023_fix_industry_fk_to_uuid',
      sql: `

            ALTER TABLE tenants
      DROP COLUMN IF EXISTS industry_id;

      -- 3. Create junction table tenant_industry
      CREATE TABLE IF NOT EXISTS tenant_industry (
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          industry_id UUID NOT NULL REFERENCES industry_configs(id) ON DELETE CASCADE,
          PRIMARY KEY (tenant_id, industry_id)
      );

      -- 4. Index for faster lookups
      CREATE INDEX IF NOT EXISTS idx_tenant_industry_tenant_id
          ON tenant_industry(tenant_id);

      CREATE INDEX IF NOT EXISTS idx_tenant_industry_industry_id
          ON tenant_industry(industry_id);

    


      `
    },
    {
  name: '016_default_tenants',
  sql: `
    INSERT INTO tenants (
      id, name, slug,  plan_type, billing_status, is_active
    )
    VALUES
    (
      uuid_generate_v4(),
      'Guest Tenant',
      'guest',
      'free',
      'active',
      TRUE
    ),
    (
      uuid_generate_v4(),
      'Demand Genius',
      'demand-genius',
      'enterprise',
      'active',
      TRUE
    )
    ON CONFLICT (slug) DO NOTHING;
  `
},
 {
  name: '017_users_add_soft_delete',
  sql: `
   ALTER TABLE users
    ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE;
  `
},
{
  name: '024_password_resets',
  sql: `
    CREATE TABLE IF NOT EXISTS password_resets (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token       VARCHAR(64) NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 hour',
      used        BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);
  `
},
{
  name: '025_phone_unique_index',
  sql: `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique
      ON users(phone) WHERE phone IS NOT NULL AND phone <> '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reg_type VARCHAR(10) DEFAULT 'email';
  `
},
{
  name: '026_purchase_order_items',
  sql: `
    DROP TABLE IF EXISTS purchase_order_items CASCADE;
    CREATE TABLE purchase_order_items (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      po_id           UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      item_id         UUID REFERENCES items(id) ON DELETE SET NULL,
      item_name       VARCHAR(255) NOT NULL,
      sku             VARCHAR(100),
      quantity        DECIMAL(10,3) NOT NULL DEFAULT 1,
      unit_price      DECIMAL(10,2) NOT NULL DEFAULT 0,
      gst_rate        DECIMAL(5,2)  DEFAULT 0,
      gst_amount      DECIMAL(10,2) GENERATED ALWAYS AS (quantity * unit_price * gst_rate / 100) STORED,
      subtotal        DECIMAL(10,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
      total           DECIMAL(10,2) GENERATED ALWAYS AS (quantity * unit_price * (1 + gst_rate/100)) STORED,
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id);
  `
},
{
  name: '026z_ensure_tenant_industries',
  sql: `
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_industry')
         AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_industries') THEN
        ALTER TABLE tenant_industry RENAME TO tenant_industries;
        ALTER INDEX IF EXISTS idx_tenant_industry_tenant_id   RENAME TO idx_tenant_industries_tenant_id;
        ALTER INDEX IF EXISTS idx_tenant_industry_industry_id RENAME TO idx_tenant_industries_industry_id;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_industries') THEN
        CREATE TABLE tenant_industries (
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          industry_id UUID NOT NULL REFERENCES industry_configs(id) ON DELETE CASCADE,
          PRIMARY KEY (tenant_id, industry_id)
        );
      END IF;
    END $$;
  `
},
{
  name: '027_grocery_domain_seed',
  sql: `
DO $$
DECLARE
  t_id UUID := '11111111-2222-3333-4444-555555555601';
  s_id UUID := '11111111-2222-3333-4444-555555555602';
  u_id UUID := '11111111-2222-3333-4444-555555555603';
  sup_id UUID;
  unit_pc UUID;
  cat_veg UUID; cat_dairy UUID; cat_grain UUID; cat_bev UUID;
BEGIN
  SELECT id INTO unit_pc FROM unit_types WHERE symbol = 'pc' LIMIT 1;
  -- Tenant
  INSERT INTO tenants (id, name, slug, plan_type, billing_status, is_active)
  VALUES (t_id, 'FreshMart Grocery', 'freshmart-grocery', 'growth', 'active', TRUE)
  ON CONFLICT (id) DO NOTHING;

  -- Link industry
  INSERT INTO tenant_industries (tenant_id, industry_id)
  SELECT t_id, id FROM industry_configs WHERE industry_id = 'grocery'
  ON CONFLICT DO NOTHING;

  -- Store
  INSERT INTO stores (id, tenant_id, name, code, is_active)
  VALUES (s_id, t_id, 'FreshMart Koramangala', 'FMK001', TRUE)
  ON CONFLICT (id) DO NOTHING;

  -- Owner user
  INSERT INTO users (id, tenant_id, store_id, email, password_hash, role, first_name, last_name, is_active)
  VALUES (u_id, t_id, s_id, 'owner@freshmart.com',
    '$2b$10$laSPM4SB2UALjDFzJnjUS.Hx5MX.of2eh0TYA09WIcCtvLtHHATg.', -- password: Admin@123
    'owner', 'Priya', 'Sharma', TRUE)
  ON CONFLICT (id) DO NOTHING;

  -- Categories
  INSERT INTO categories (id, tenant_id, name, description) VALUES
    (gen_random_uuid(), t_id, 'Vegetables & Fruits', 'Fresh produce'),
    (gen_random_uuid(), t_id, 'Dairy & Eggs', 'Milk, cheese, eggs'),
    (gen_random_uuid(), t_id, 'Grains & Pulses', 'Rice, wheat, dal'),
    (gen_random_uuid(), t_id, 'Beverages', 'Juices, tea, coffee')
  ON CONFLICT DO NOTHING;

  SELECT id INTO cat_veg   FROM categories WHERE tenant_id=t_id AND name='Vegetables & Fruits' LIMIT 1;
  SELECT id INTO cat_dairy FROM categories WHERE tenant_id=t_id AND name='Dairy & Eggs'        LIMIT 1;
  SELECT id INTO cat_grain FROM categories WHERE tenant_id=t_id AND name='Grains & Pulses'     LIMIT 1;
  SELECT id INTO cat_bev   FROM categories WHERE tenant_id=t_id AND name='Beverages'           LIMIT 1;

  -- Supplier
  INSERT INTO suppliers (id, tenant_id, name, email, phone, is_active)
  VALUES (gen_random_uuid(), t_id, 'Metro Cash & Carry', 'orders@metro.in', '+91 9880001100', TRUE)
  ON CONFLICT DO NOTHING;
  SELECT id INTO sup_id FROM suppliers WHERE tenant_id=t_id LIMIT 1;

  -- Items
  INSERT INTO items (tenant_id, store_id, name, sku, category_id, supplier_id,
    current_stock, reorder_level, max_stock_level, selling_price, purchase_price,
    mrp, gst_rate, primary_unit_id, is_active) VALUES
    (t_id, s_id, 'Tomatoes (1kg)', 'VEG001', cat_veg,   sup_id, 45, 20, 200, 35,  25,  40,  0, unit_pc, TRUE),
    (t_id, s_id, 'Onions (1kg)',   'VEG002', cat_veg,   sup_id, 80, 30, 300, 30,  20,  35,  0, unit_pc, TRUE),
    (t_id, s_id, 'Potatoes (1kg)', 'VEG003', cat_veg,   sup_id, 12, 25, 200, 28,  18,  32,  0, unit_pc, TRUE),
    (t_id, s_id, 'Amul Milk 1L',   'DAI001', cat_dairy, sup_id, 60, 30, 200, 62,  55,  65,  5, unit_pc, TRUE),
    (t_id, s_id, 'Eggs (Dozen)',   'DAI002', cat_dairy, sup_id, 25, 15, 100, 85,  72,  90,  0, unit_pc, TRUE),
    (t_id, s_id, 'Amul Butter',    'DAI003', cat_dairy, sup_id,  8, 10,  80, 55,  48,  60,  5, unit_pc, TRUE),
    (t_id, s_id, 'Basmati Rice 5kg','GRN001',cat_grain, sup_id, 35, 20, 150, 399, 320, 450, 5, unit_pc, TRUE),
    (t_id, s_id, 'Toor Dal 1kg',   'GRN002', cat_grain, sup_id, 18, 15, 100, 145, 120, 160, 5, unit_pc, TRUE),
    (t_id, s_id, 'Wheat Flour 5kg','GRN003', cat_grain, sup_id, 40, 20, 200, 240, 195, 270, 0, unit_pc, TRUE),
    (t_id, s_id, 'Tropicana Orange 1L','BEV001',cat_bev,sup_id,20, 15, 100, 120,  95, 135, 12, unit_pc, TRUE),
    (t_id, s_id, 'Bru Coffee 200g','BEV002', cat_bev,  sup_id, 15, 10,  80, 249, 205, 280, 12, unit_pc, TRUE),
    (t_id, s_id, 'Tata Tea Gold 250g','BEV003',cat_bev,sup_id,  4, 10,  80, 180, 145, 199, 12, unit_pc, TRUE)
  ON CONFLICT DO NOTHING;
END $$;
  `
},
{
  name: '028_parts_domain_seed',
  sql: `
DO $$
DECLARE
  t_id UUID := '22222222-3333-4444-5555-666666666601';
  s_id UUID := '22222222-3333-4444-5555-666666666602';
  u_id UUID := '22222222-3333-4444-5555-666666666603';
  sup_id UUID;
  unit_pc UUID;
  cat_eng UUID; cat_elec UUID; cat_body UUID; cat_tyre UUID;
BEGIN
  SELECT id INTO unit_pc FROM unit_types WHERE symbol = 'pc' LIMIT 1;
  INSERT INTO tenants (id, name, slug, plan_type, billing_status, is_active)
  VALUES (t_id, 'AutoZone Parts', 'autozone-parts', 'growth', 'active', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO tenant_industries (tenant_id, industry_id)
  SELECT t_id, id FROM industry_configs WHERE industry_id = 'auto'
  ON CONFLICT DO NOTHING;

  INSERT INTO stores (id, tenant_id, name, code, is_active)
  VALUES (s_id, t_id, 'AutoZone Whitefield', 'AZW001', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO users (id, tenant_id, store_id, email, password_hash, role, first_name, last_name, is_active)
  VALUES (u_id, t_id, s_id, 'owner@autozone.com',
    '$2b$10$laSPM4SB2UALjDFzJnjUS.Hx5MX.of2eh0TYA09WIcCtvLtHHATg.',
    'owner', 'Rahul', 'Mehta', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO categories (id, tenant_id, name, description) VALUES
    (gen_random_uuid(), t_id, 'Engine Parts',   'Filters, belts, gaskets'),
    (gen_random_uuid(), t_id, 'Electrical',     'Batteries, lights, fuses'),
    (gen_random_uuid(), t_id, 'Body & Exterior','Mirrors, bumpers, wipers'),
    (gen_random_uuid(), t_id, 'Tyres & Wheels', 'Tyres, rims, tubes')
  ON CONFLICT DO NOTHING;

  SELECT id INTO cat_eng  FROM categories WHERE tenant_id=t_id AND name='Engine Parts'   LIMIT 1;
  SELECT id INTO cat_elec FROM categories WHERE tenant_id=t_id AND name='Electrical'     LIMIT 1;
  SELECT id INTO cat_body FROM categories WHERE tenant_id=t_id AND name='Body & Exterior'LIMIT 1;
  SELECT id INTO cat_tyre FROM categories WHERE tenant_id=t_id AND name='Tyres & Wheels' LIMIT 1;

  INSERT INTO suppliers (id, tenant_id, name, email, phone, is_active)
  VALUES (gen_random_uuid(), t_id, 'Bosch India Ltd', 'orders@bosch.in', '+91 9900112233', TRUE)
  ON CONFLICT DO NOTHING;
  SELECT id INTO sup_id FROM suppliers WHERE tenant_id=t_id LIMIT 1;

  INSERT INTO items (tenant_id, store_id, name, sku, category_id, supplier_id,
    current_stock, reorder_level, max_stock_level, selling_price, purchase_price,
    mrp, gst_rate, primary_unit_id, is_active) VALUES
    (t_id, s_id, 'Oil Filter (Maruti)',  'ENG001', cat_eng,  sup_id, 25, 10, 100, 350, 280, 400, 28, unit_pc, TRUE),
    (t_id, s_id, 'Air Filter (i20)',     'ENG002', cat_eng,  sup_id, 18, 8,   80, 480, 390, 550, 28, unit_pc, TRUE),
    (t_id, s_id, 'Timing Belt Set',      'ENG003', cat_eng,  sup_id,  4, 5,   40, 2200,1800,2500,28, unit_pc, TRUE),
    (t_id, s_id, 'Spark Plugs (Set 4)',  'ENG004', cat_eng,  sup_id, 30, 12, 120, 650, 520, 720, 28, unit_pc, TRUE),
    (t_id, s_id, 'Amaron 45Ah Battery', 'ELC001', cat_elec, sup_id,  6, 4,   30, 4200,3500,4800,28, unit_pc, TRUE),
    (t_id, s_id, 'Headlight H4 Bulb',   'ELC002', cat_elec, sup_id, 35, 15, 150, 180, 145, 210, 28, unit_pc, TRUE),
    (t_id, s_id, 'Fuse Box Set',         'ELC003', cat_elec, sup_id, 20, 10, 100, 120,  95, 140, 28, unit_pc, TRUE),
    (t_id, s_id, 'Side Mirror (Swift)',  'BDY001', cat_body, sup_id, 8,  4,   40, 850, 700, 950, 28, unit_pc, TRUE),
    (t_id, s_id, 'Wiper Blade Set',      'BDY002', cat_body, sup_id, 22, 10, 100, 380, 300, 450, 28, unit_pc, TRUE),
    (t_id, s_id, 'MRF Tyres 165/80R14', 'TYR001', cat_tyre, sup_id,  2, 4,   20,4500,3900,5000,28, unit_pc, TRUE),
    (t_id, s_id, 'CEAT Tyres 185/65R15','TYR002', cat_tyre, sup_id,  3, 4,   20,5200,4500,5800,28, unit_pc, TRUE),
    (t_id, s_id, 'Wheel Rim (Steel)',    'TYR003', cat_tyre, sup_id,  5, 4,   30,1800,1500,2000,28, unit_pc, TRUE)
  ON CONFLICT DO NOTHING;
END $$;
  `
},
{
  name: '029_medical_domain_seed',
  sql: `
DO $$
DECLARE
  t_id UUID := '33333333-4444-5555-6666-777777777701';
  s_id UUID := '33333333-4444-5555-6666-777777777702';
  u_id UUID := '33333333-4444-5555-6666-777777777703';
  sup_id UUID;
  unit_strip UUID;
  cat_card UUID; cat_diab UUID; cat_surg UUID; cat_vita UUID;
BEGIN
  SELECT id INTO unit_strip FROM unit_types WHERE symbol = 'strip' LIMIT 1;
  INSERT INTO tenants (id, name, slug, plan_type, billing_status, is_active)
  VALUES (t_id, 'MedCare Clinic Stores', 'medcare-clinic', 'growth', 'active', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO tenant_industries (tenant_id, industry_id)
  SELECT t_id, id FROM industry_configs WHERE industry_id = 'pharma'
  ON CONFLICT DO NOTHING;

  INSERT INTO stores (id, tenant_id, name, code, is_active)
  VALUES (s_id, t_id, 'MedCare Indiranagar', 'MCI001', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO users (id, tenant_id, store_id, email, password_hash, role, first_name, last_name, is_active)
  VALUES (u_id, t_id, s_id, 'owner@medcare.com',
    '$2b$10$laSPM4SB2UALjDFzJnjUS.Hx5MX.of2eh0TYA09WIcCtvLtHHATg.',
    'owner', 'Dr. Anita', 'Nair', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO categories (id, tenant_id, name) VALUES
    (gen_random_uuid(), t_id, 'Cardiac Medicines'),
    (gen_random_uuid(), t_id, 'Diabetes Care'),
    (gen_random_uuid(), t_id, 'Surgical Supplies'),
    (gen_random_uuid(), t_id, 'Vitamins & Supplements')
  ON CONFLICT DO NOTHING;

  SELECT id INTO cat_card FROM categories WHERE tenant_id=t_id AND name='Cardiac Medicines'      LIMIT 1;
  SELECT id INTO cat_diab FROM categories WHERE tenant_id=t_id AND name='Diabetes Care'          LIMIT 1;
  SELECT id INTO cat_surg FROM categories WHERE tenant_id=t_id AND name='Surgical Supplies'      LIMIT 1;
  SELECT id INTO cat_vita FROM categories WHERE tenant_id=t_id AND name='Vitamins & Supplements' LIMIT 1;

  INSERT INTO suppliers (id, tenant_id, name, email, phone, is_active)
  VALUES (gen_random_uuid(), t_id, 'Sun Pharma Distributors', 'orders@sunpharma.in', '+91 9811223344', TRUE)
  ON CONFLICT DO NOTHING;
  SELECT id INTO sup_id FROM suppliers WHERE tenant_id=t_id LIMIT 1;

  INSERT INTO items (tenant_id, store_id, name, sku, category_id, supplier_id,
    current_stock, reorder_level, max_stock_level, selling_price, purchase_price,
    mrp, gst_rate, primary_unit_id, expiry_date, batch_number, is_active) VALUES
    (t_id, s_id, 'Ecosprin 75mg (30s)',     'CAR001', cat_card, sup_id, 80, 30, 300, 28,  22,  35,  5, unit_strip,
     CURRENT_DATE + INTERVAL '18 months', 'B2025C001', TRUE),
    (t_id, s_id, 'Atorvastatin 10mg (15s)', 'CAR002', cat_card, sup_id, 45, 20, 200, 85,  68,  95,  5, unit_strip,
     CURRENT_DATE + INTERVAL '24 months', 'B2025C002', TRUE),
    (t_id, s_id, 'Amlodipine 5mg (30s)',    'CAR003', cat_card, sup_id, 12, 20, 150, 62,  50,  72,  5, unit_strip,
     CURRENT_DATE + INTERVAL '20 months', 'B2025C003', TRUE),
    (t_id, s_id, 'Metformin 500mg (30s)',   'DIA001', cat_diab, sup_id, 90, 40, 400, 45,  35,  55,  5, unit_strip,
     CURRENT_DATE + INTERVAL '22 months', 'B2025D001', TRUE),
    (t_id, s_id, 'Glimepiride 1mg (30s)',   'DIA002', cat_diab, sup_id, 35, 20, 200, 78,  62,  90,  5, unit_strip,
     CURRENT_DATE + INTERVAL '15 months', 'B2025D002', TRUE),
    (t_id, s_id, 'Glucometer Strips (50s)', 'DIA003', cat_diab, sup_id,  8, 10,  80, 650, 520, 720, 12, unit_strip,
     CURRENT_DATE + INTERVAL '30 months', 'B2025D003', TRUE),
    (t_id, s_id, 'Surgical Gloves L (100)', 'SUR001', cat_surg, sup_id, 15, 10, 100, 350, 280, 400, 12, unit_strip,
     CURRENT_DATE + INTERVAL '36 months', 'B2025S001', TRUE),
    (t_id, s_id, '5ml Syringe (25pcs)',     'SUR002', cat_surg, sup_id, 40, 20, 200, 120,  95, 140, 12, unit_strip,
     CURRENT_DATE + INTERVAL '36 months', 'B2025S002', TRUE),
    (t_id, s_id, 'Dressing Gauze Roll',     'SUR003', cat_surg, sup_id,  6, 10,  80, 85,   68,  99, 12, unit_strip,
     CURRENT_DATE + INTERVAL '24 months', 'B2025S003', TRUE),
    (t_id, s_id, 'Vitamin D3 60K (4s)',     'VIT001', cat_vita, sup_id, 55, 25, 250, 185, 148, 210, 12, unit_strip,
     CURRENT_DATE + INTERVAL '24 months', 'B2025V001', TRUE),
    (t_id, s_id, 'Multivitamin (30s)',      'VIT002', cat_vita, sup_id, 38, 20, 200, 245, 195, 280, 12, unit_strip,
     CURRENT_DATE + INTERVAL '18 months', 'B2025V002', TRUE),
    (t_id, s_id, 'Omega-3 Capsules (30s)', 'VIT003', cat_vita, sup_id,  4, 15, 120, 320, 255, 370, 12, unit_strip,
     CURRENT_DATE + INTERVAL '20 months', 'B2025V003', TRUE)
  ON CONFLICT DO NOTHING;
END $$;
  `
},
{
  name: '030_rename_tenant_industry_to_industries',
  sql: `
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_industry')
         AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_industries') THEN
        ALTER TABLE tenant_industry RENAME TO tenant_industries;
        ALTER INDEX IF EXISTS idx_tenant_industry_tenant_id   RENAME TO idx_tenant_industries_tenant_id;
        ALTER INDEX IF EXISTS idx_tenant_industry_industry_id RENAME TO idx_tenant_industries_industry_id;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_industries') THEN
        CREATE TABLE tenant_industries (
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          industry_id UUID NOT NULL REFERENCES industry_configs(id) ON DELETE CASCADE,
          PRIMARY KEY (tenant_id, industry_id)
        );
      END IF;
    END $$;
  `
},
{
  name: '031_stores_lat_lng',
  sql: `
    ALTER TABLE stores
      ADD COLUMN IF NOT EXISTS lat DECIMAL(10,7),
      ADD COLUMN IF NOT EXISTS lng DECIMAL(10,7);
  `
},
{
  name: '032_tea_industry',
  sql: `
    INSERT INTO industry_configs
      (industry_id, display_name, item_noun, default_unit_symbol,
       domain_keywords, off_topic_keywords, seasonal_signals,
       prompt_context, low_stock_days, expiry_warn_days)
    VALUES
      ('tea', 'Tea Procurement', 'Tea Leaves', 'kg',
       ARRAY['tea','grower','collection','factory','dispatch','settlement'],
       ARRAY['medicine','auto','electronics'],
       ARRAY['monsoon','harvest'],
       'Tea procurement and settlement management for tea agents',
       0, 0)
    ON CONFLICT (industry_id) DO NOTHING;
  `
},
{
  name: '033_tea_tables',
  sql: `
    -- Tea Growers
    CREATE TABLE IF NOT EXISTS tea_growers (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      grower_code VARCHAR(20),
      name VARCHAR(200) NOT NULL,
      phone VARCHAR(20),
      address TEXT,
      land_acres DECIMAL(8,2),
      land_type VARCHAR(50),
      pluck_cycle_days INT DEFAULT 15,
      last_pluck_date DATE,
      will_pluck BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Weekly Buying Rates
    CREATE TABLE IF NOT EXISTS tea_weekly_rates (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      week_number INT NOT NULL,
      week_year INT NOT NULL,
      grade_a_rate DECIMAL(10,2) NOT NULL,
      grade_b_rate DECIMAL(10,2) NOT NULL,
      grade_c_rate DECIMAL(10,2) NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, week_number, week_year)
    );

    -- Collection Batches (daily header)
    CREATE TABLE IF NOT EXISTS tea_collection_batches (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      collection_date DATE NOT NULL DEFAULT CURRENT_DATE,
      total_kg DECIMAL(10,2) DEFAULT 0,
      total_amount DECIMAL(12,2) DEFAULT 0,
      grower_count INT DEFAULT 0,
      status VARCHAR(30) DEFAULT 'open',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Collection Entries (per grower per batch)
    CREATE TABLE IF NOT EXISTS tea_collections (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      batch_id UUID NOT NULL REFERENCES tea_collection_batches(id) ON DELETE CASCADE,
      grower_id UUID NOT NULL REFERENCES tea_growers(id),
      gross_weight DECIMAL(10,2) NOT NULL,
      moisture_deduction_kg DECIMAL(10,2) DEFAULT 0,
      net_weight DECIMAL(10,2) NOT NULL,
      grade VARCHAR(5) DEFAULT 'A',
      rate_per_kg DECIMAL(10,2) DEFAULT 0,
      amount DECIMAL(12,2) DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Factories
    CREATE TABLE IF NOT EXISTS tea_factories (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(200) NOT NULL,
      contact_name VARCHAR(200),
      phone VARCHAR(20),
      address TEXT,
      current_rate_per_kg DECIMAL(10,2),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Dispatch Header
    CREATE TABLE IF NOT EXISTS tea_dispatches (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      factory_id UUID NOT NULL REFERENCES tea_factories(id),
      vehicle_id UUID,
      dispatch_date DATE NOT NULL DEFAULT CURRENT_DATE,
      total_kg DECIMAL(10,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) DEFAULT 'dispatched',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Dispatch Details (batch to dispatch mapping)
    CREATE TABLE IF NOT EXISTS tea_dispatch_details (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      dispatch_id UUID NOT NULL REFERENCES tea_dispatches(id) ON DELETE CASCADE,
      batch_id UUID NOT NULL REFERENCES tea_collection_batches(id),
      UNIQUE(dispatch_id, batch_id)
    );

    -- Factory Settlements
    CREATE TABLE IF NOT EXISTS tea_factory_settlements (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      dispatch_id UUID NOT NULL REFERENCES tea_dispatches(id),
      accepted_kg DECIMAL(10,2) NOT NULL,
      rejected_kg DECIMAL(10,2) DEFAULT 0,
      rate_per_kg DECIMAL(10,2) NOT NULL,
      total_amount DECIMAL(12,2) NOT NULL,
      settled_at TIMESTAMPTZ DEFAULT NOW(),
      payment_received BOOLEAN DEFAULT FALSE,
      payment_received_at TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Factory Advances
    CREATE TABLE IF NOT EXISTS tea_factory_advances (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      factory_id UUID NOT NULL REFERENCES tea_factories(id),
      amount DECIMAL(12,2) NOT NULL,
      advance_date DATE NOT NULL DEFAULT CURRENT_DATE,
      repaid BOOLEAN DEFAULT FALSE,
      repaid_at TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Grower Advances
    CREATE TABLE IF NOT EXISTS tea_grower_advances (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      grower_id UUID NOT NULL REFERENCES tea_growers(id),
      amount DECIMAL(12,2) NOT NULL,
      advance_date DATE NOT NULL DEFAULT CURRENT_DATE,
      deducted BOOLEAN DEFAULT FALSE,
      deducted_at TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Weekly Grower Settlements
    CREATE TABLE IF NOT EXISTS tea_grower_settlements (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      grower_id UUID NOT NULL REFERENCES tea_growers(id),
      week_start_date DATE NOT NULL,
      week_end_date DATE NOT NULL,
      total_kg DECIMAL(10,2) NOT NULL DEFAULT 0,
      gross_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      advance_deduction DECIMAL(12,2) DEFAULT 0,
      net_payable DECIMAL(12,2) NOT NULL DEFAULT 0,
      paid BOOLEAN DEFAULT FALSE,
      paid_at TIMESTAMPTZ,
      payment_method VARCHAR(50),
      payment_ref VARCHAR(200),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, grower_id, week_start_date, week_end_date)
    );

    -- Vehicles
    CREATE TABLE IF NOT EXISTS tea_vehicles (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      vehicle_number VARCHAR(20) NOT NULL,
      driver_name VARCHAR(200),
      driver_phone VARCHAR(20),
      is_rental BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Add vehicle FK to dispatches
    ALTER TABLE tea_dispatches
      ADD COLUMN IF NOT EXISTS vehicle_id_fk UUID REFERENCES tea_vehicles(id);
  `
},
{
  name: '035_fix_superadmin_password',
  sql: `
    -- Force-update superadmin password to Admin@123
    -- (original seed used ON CONFLICT DO NOTHING, so old hash persisted)
    UPDATE users
    SET password_hash = '$2b$10$laSPM4SB2UALjDFzJnjUS.Hx5MX.of2eh0TYA09WIcCtvLtHHATg.',
        updated_at    = NOW()
    WHERE email = 'superadmin@genericdemandai.com'
      AND role  = 'superadmin';
  `
},
{
  name: '034_tea_seed',
  sql: `
DO $$
DECLARE
  v_tenant_id UUID := 'aaaaaaaa-1111-2222-3333-444444444401';
  v_store_id  UUID := 'aaaaaaaa-1111-2222-3333-444444444402';
  v_user_id   UUID := 'aaaaaaaa-1111-2222-3333-444444444403';
  v_grower1   UUID; v_grower2 UUID; v_grower3 UUID; v_grower4 UUID;
  v_factory_a UUID; v_factory_b UUID; v_factory_c UUID;
  v_vehicle1  UUID;
  v_industry_id UUID;
BEGIN
  -- Get tea industry id
  SELECT id INTO v_industry_id FROM industry_configs WHERE industry_id = 'tea';

  -- Tenant: ABC Tea Agency
  INSERT INTO tenants (id, name, slug, plan_type, billing_status, is_active)
  VALUES (v_tenant_id, 'ABC Tea Agency', 'abc-tea-agency', 'growth', 'active', TRUE)
  ON CONFLICT (id) DO NOTHING;

  -- Link industry
  IF v_industry_id IS NOT NULL THEN
    INSERT INTO tenant_industries (tenant_id, industry_id)
    VALUES (v_tenant_id, v_industry_id)
    ON CONFLICT DO NOTHING;
  END IF;

  -- Store
  INSERT INTO stores (id, tenant_id, name, code, city, state, phone, is_active)
  VALUES (v_store_id, v_tenant_id, 'ABC Tea Agency HQ', 'TEA001', 'Nilgiris', 'Tamil Nadu', '+91 9800001234', TRUE)
  ON CONFLICT (id) DO NOTHING;

  -- Owner user
  INSERT INTO users (id, tenant_id, store_id, email, password_hash, role, first_name, last_name, is_active)
  VALUES (v_user_id, v_tenant_id, v_store_id, 'owner@abcteaagency.com',
    '$2b$10$laSPM4SB2UALjDFzJnjUS.Hx5MX.of2eh0TYA09WIcCtvLtHHATg.',
    'owner', 'ABC Tea', 'Owner', TRUE)
  ON CONFLICT (id) DO NOTHING;

  -- Growers
  INSERT INTO tea_growers (id, tenant_id, grower_code, name, phone, land_acres, pluck_cycle_days, last_pluck_date)
  VALUES
    (uuid_generate_v4(), v_tenant_id, 'TG001', 'Ravi Kumar', '+91 9811111111', 2.5, 15, CURRENT_DATE - 10),
    (uuid_generate_v4(), v_tenant_id, 'TG002', 'Mani',       '+91 9822222222', 1.8, 15, CURRENT_DATE - 12),
    (uuid_generate_v4(), v_tenant_id, 'TG003', 'Kumar',      '+91 9833333333', 3.0, 30, CURRENT_DATE - 8),
    (uuid_generate_v4(), v_tenant_id, 'TG004', 'Suresh',     '+91 9844444444', 2.0, 15, CURRENT_DATE - 5)
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_grower1 FROM tea_growers WHERE tenant_id=v_tenant_id AND grower_code='TG001';
  SELECT id INTO v_grower2 FROM tea_growers WHERE tenant_id=v_tenant_id AND grower_code='TG002';
  SELECT id INTO v_grower3 FROM tea_growers WHERE tenant_id=v_tenant_id AND grower_code='TG003';
  SELECT id INTO v_grower4 FROM tea_growers WHERE tenant_id=v_tenant_id AND grower_code='TG004';

  -- Factories
  INSERT INTO tea_factories (id, tenant_id, name, current_rate_per_kg)
  VALUES
    (uuid_generate_v4(), v_tenant_id, 'Factory A', 36.00),
    (uuid_generate_v4(), v_tenant_id, 'Factory B', 34.50),
    (uuid_generate_v4(), v_tenant_id, 'Factory C', 33.00)
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_factory_a FROM tea_factories WHERE tenant_id=v_tenant_id AND name='Factory A';
  SELECT id INTO v_factory_b FROM tea_factories WHERE tenant_id=v_tenant_id AND name='Factory B';
  SELECT id INTO v_factory_c FROM tea_factories WHERE tenant_id=v_tenant_id AND name='Factory C';

  -- Vehicles
  INSERT INTO tea_vehicles (tenant_id, vehicle_number, driver_name, is_rental)
  VALUES
    (v_tenant_id, 'TN09AB1234', 'Raj',    FALSE),
    (v_tenant_id, 'TN09AB4567', 'Kumar',  FALSE),
    (v_tenant_id, 'Rental Vehicle 1', 'Driver', TRUE)
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_vehicle1 FROM tea_vehicles WHERE tenant_id=v_tenant_id AND vehicle_number='TN09AB1234';

  -- Weekly rate (Week 28)
  INSERT INTO tea_weekly_rates (tenant_id, week_number, week_year, grade_a_rate, grade_b_rate, grade_c_rate)
  VALUES (v_tenant_id, 28, EXTRACT(YEAR FROM NOW())::int, 34.00, 31.00, 28.00)
  ON CONFLICT (tenant_id, week_number, week_year) DO NOTHING;

  -- Sample collection batch (today)
  IF v_grower1 IS NOT NULL THEN
    WITH batch AS (
      INSERT INTO tea_collection_batches (tenant_id, collection_date, status)
      VALUES (v_tenant_id, CURRENT_DATE, 'open')
      ON CONFLICT DO NOTHING
      RETURNING id
    ),
    bid AS (SELECT id FROM batch UNION ALL SELECT id FROM tea_collection_batches WHERE tenant_id=v_tenant_id AND collection_date=CURRENT_DATE LIMIT 1)
    INSERT INTO tea_collections (batch_id, grower_id, gross_weight, moisture_deduction_kg, net_weight, grade, rate_per_kg, amount)
    SELECT bid.id, unnest(ARRAY[v_grower1, v_grower2, v_grower3]),
           unnest(ARRAY[128.0, 120.0, 135.0]::decimal[]),
           unnest(ARRAY[2.56, 3.0, 2.7]::decimal[]),
           unnest(ARRAY[125.44, 117.0, 132.3]::decimal[]),
           unnest(ARRAY['A', 'B', 'A']::varchar[]),
           unnest(ARRAY[0, 0, 0]::decimal[]),
           unnest(ARRAY[0, 0, 0]::decimal[])
    FROM bid
    LIMIT 3
    ON CONFLICT DO NOTHING;
  END IF;

END $$;
  `
},
{
  name: '036_restore_tenant_industry_id',
  sql: `
    -- Restore the industry_id varchar column that was dropped in 023.
    -- All service queries reference t.industry_id as the varchar code (e.g. 'tea', 'pharma').
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS industry_id VARCHAR(50);

    -- Populate from the tenant_industries junction table
    UPDATE tenants t
    SET industry_id = ic.industry_id
    FROM tenant_industries ti
    JOIN industry_configs ic ON ic.id = ti.industry_id
    WHERE ti.tenant_id = t.id
      AND t.industry_id IS NULL;

    -- Default for any tenants not linked to an industry
    UPDATE tenants
    SET industry_id = 'generic'
    WHERE industry_id IS NULL;
  `
},
{
  name: '037_tea_payment_mode',
  sql: `
    ALTER TABLE tea_weekly_rates
      ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(10) DEFAULT 'full',
      ADD COLUMN IF NOT EXISTS advance_rate_a DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS advance_rate_b DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS advance_rate_c DECIMAL(10,2);

    ALTER TABLE tea_grower_settlements
      ADD COLUMN IF NOT EXISTS balance_carried_forward DECIMAL(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(10) DEFAULT 'full';
  `
},
{
  name: '038_multi_features',
  sql: `
    -- Rack location on items (pharma, grocery, parts shelf lookup)
    ALTER TABLE items ADD COLUMN IF NOT EXISTS rack_location VARCHAR(50);

    -- Collection manager role
    DO $$ BEGIN
      ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'collection_manager';
    EXCEPTION WHEN others THEN NULL; END $$;

    -- Grower portal access (owner sets PIN for each grower)
    ALTER TABLE tea_growers
      ADD COLUMN IF NOT EXISTS portal_enabled BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS portal_pin_hash VARCHAR(255);

    -- Workers under a grower (the actual field pluckers)
    CREATE TABLE IF NOT EXISTS tea_grower_workers (
      id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      grower_id    UUID NOT NULL REFERENCES tea_growers(id) ON DELETE CASCADE,
      name         VARCHAR(100) NOT NULL,
      phone        VARCHAR(20),
      wage_type    VARCHAR(10) DEFAULT 'daily',
      daily_wage   DECIMAL(10,2) DEFAULT 0,
      per_kg_wage  DECIMAL(10,2) DEFAULT 0,
      is_active    BOOLEAN DEFAULT TRUE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tea_grower_workers_grower ON tea_grower_workers(grower_id);

    -- Daily pluck log per worker
    CREATE TABLE IF NOT EXISTS tea_worker_daily_pluck (
      id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      grower_id    UUID NOT NULL REFERENCES tea_growers(id) ON DELETE CASCADE,
      worker_id    UUID NOT NULL REFERENCES tea_grower_workers(id) ON DELETE CASCADE,
      pluck_date   DATE NOT NULL DEFAULT CURRENT_DATE,
      kg_plucked   DECIMAL(10,2) NOT NULL DEFAULT 0,
      wage_amount  DECIMAL(10,2) DEFAULT 0,
      is_paid      BOOLEAN DEFAULT FALSE,
      notes        TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(worker_id, pluck_date)
    );
    CREATE INDEX IF NOT EXISTS idx_tea_worker_pluck_grower ON tea_worker_daily_pluck(grower_id, pluck_date);

    -- Vehicle fuel / expense logs
    CREATE TABLE IF NOT EXISTS tea_vehicle_fuel_logs (
      id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      vehicle_id      UUID NOT NULL REFERENCES tea_vehicles(id) ON DELETE CASCADE,
      log_date        DATE NOT NULL DEFAULT CURRENT_DATE,
      fuel_type       VARCHAR(10) NOT NULL DEFAULT 'diesel',
      liters          DECIMAL(8,2) NOT NULL,
      rate_per_liter  DECIMAL(8,2),
      total_cost      DECIMAL(10,2),
      odometer_km     INT,
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tea_fuel_vehicle ON tea_vehicle_fuel_logs(vehicle_id, log_date);
  `
},
{
  name: '040_factory_settlement_grades',
  sql: `
    ALTER TABLE tea_factory_settlements
      ADD COLUMN IF NOT EXISTS grade_a_kg      DECIMAL(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS grade_b_kg      DECIMAL(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS grade_c_kg      DECIMAL(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS rate_per_kg_a   DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS rate_per_kg_b   DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS rate_per_kg_c   DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS deductions      DECIMAL(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS settlement_date DATE;
    -- Back-fill settlement_date from settled_at for existing rows
    UPDATE tea_factory_settlements SET settlement_date = settled_at::date WHERE settlement_date IS NULL;
  `
},
{
  name: '041_dispatch_bags',
  sql: `
    CREATE TABLE IF NOT EXISTS tea_dispatch_bags (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      dispatch_id UUID NOT NULL REFERENCES tea_dispatches(id) ON DELETE CASCADE,
      bag_number  INT NOT NULL,
      weight_kg   DECIMAL(10,2) NOT NULL,
      grade       VARCHAR(5) NOT NULL DEFAULT 'A',
      notes       TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(dispatch_id, bag_number)
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_bags_dispatch ON tea_dispatch_bags(dispatch_id);

    -- Add driver info to dispatches if not present
    ALTER TABLE tea_dispatches
      ADD COLUMN IF NOT EXISTS driver_name       VARCHAR(100),
      ADD COLUMN IF NOT EXISTS driver_phone      VARCHAR(20),
      ADD COLUMN IF NOT EXISTS factory_total_kg  DECIMAL(10,2);

    -- Per-bag factory weight (leave NULL until factory weighs it)
    ALTER TABLE tea_dispatch_bags
      ADD COLUMN IF NOT EXISTS factory_weight_kg DECIMAL(10,2);
  `
},
{
  name: '039_moisture_kg',
  sql: `
    -- Moisture deduction is in kg, not percentage
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='tea_collections' AND column_name='moisture_deduction_pct'
      ) THEN
        ALTER TABLE tea_collections RENAME COLUMN moisture_deduction_pct TO moisture_deduction_kg;
      END IF;
    END $$;
    ALTER TABLE tea_collections ADD COLUMN IF NOT EXISTS moisture_deduction_kg DECIMAL(10,2) DEFAULT 0;

    -- Clear stale rate/amount snapshots so settlement recalculates clean
    UPDATE tea_collections SET rate_per_kg = 0, amount = 0;
    UPDATE tea_collection_batches SET total_amount = 0;
  `
},
{
  name: '042_wa_sessions',
  sql: `
    CREATE TABLE IF NOT EXISTS wa_sessions (
      id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      wa_phone     VARCHAR(20) NOT NULL UNIQUE,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      store_id     UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wa_sessions_phone ON wa_sessions(wa_phone);
  `
},
{
  name: '043_explore_demo_data',
  sql: `
  -- Update stores with city/state/phone so explore page nearby search works
  UPDATE stores SET
    city    = 'Bangalore',
    state   = 'Karnataka',
    address = 'Shop No. 12, 6th Block, Koramangala, Bangalore – 560095',
    phone   = '+91 9880100200',
    owner_name = 'Priya Sharma'
  WHERE id = '11111111-2222-3333-4444-555555555602';

  UPDATE stores SET
    city    = 'Bangalore',
    state   = 'Karnataka',
    address = '45, Whitefield Main Road, Bangalore – 560066',
    phone   = '+91 9900112200',
    owner_name = 'Rahul Mehta'
  WHERE id = '22222222-3333-4444-5555-666666666602';

  UPDATE stores SET
    city    = 'Bangalore',
    state   = 'Karnataka',
    address = '3rd Cross, Indiranagar, Bangalore – 560038',
    phone   = '+91 9811220033',
    owner_name = 'Dr. Anita Nair'
  WHERE id = '33333333-4444-5555-6666-777777777702';

  -- Update Apollo Pharmacy with phone (city/state already set)
  UPDATE stores SET
    phone      = '+91 8041234567',
    owner_name = 'Apollo Pharmacy'
  WHERE id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee02';
  `
},
{
  name: '044_public_listings',
  sql: `
    CREATE TABLE IF NOT EXISTS public_listings (
      id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      type          VARCHAR(30)  NOT NULL,
      name          VARCHAR(200) NOT NULL,
      phone         VARCHAR(20)  NOT NULL,
      city          VARCHAR(100),
      state         VARCHAR(100),
      address       TEXT,
      description   TEXT,
      rate_info     TEXT,
      discount      TEXT,
      services      JSONB    DEFAULT '[]',
      available_now BOOLEAN  DEFAULT TRUE,
      availability  JSONB    DEFAULT '{}',
      is_active     BOOLEAN  DEFAULT TRUE,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_public_listings_type   ON public_listings(type);
    CREATE INDEX IF NOT EXISTS idx_public_listings_city   ON public_listings(city);
    CREATE INDEX IF NOT EXISTS idx_public_listings_active ON public_listings(is_active, available_now);
  `
},
{
  name: '045_listings_lat_lng',
  sql: `
    ALTER TABLE public_listings
      ADD COLUMN IF NOT EXISTS lat DECIMAL(10,7),
      ADD COLUMN IF NOT EXISTS lng DECIMAL(10,7);
    CREATE INDEX IF NOT EXISTS idx_public_listings_loc ON public_listings(lat, lng) WHERE lat IS NOT NULL;
  `
},
{
  name: '046_listings_mode',
  sql: `
    ALTER TABLE public_listings
      ADD COLUMN IF NOT EXISTS mode VARCHAR(10) NOT NULL DEFAULT 'provider';
  `
},
{
  name: '047_guest_sessions',
  sql: `
    CREATE TABLE IF NOT EXISTS explore_sessions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      guest_id VARCHAR(50) NOT NULL,
      guest_name VARCHAR(200),
      session_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_explore_sessions_unique
      ON explore_sessions(guest_id, session_date);
    CREATE INDEX IF NOT EXISTS idx_explore_sessions_date
      ON explore_sessions(session_date);

    CREATE TABLE IF NOT EXISTS explore_guests (
      guest_id VARCHAR(50) PRIMARY KEY,
      guest_name VARCHAR(200),
      first_seen DATE NOT NULL DEFAULT CURRENT_DATE,
      last_seen DATE NOT NULL DEFAULT CURRENT_DATE,
      total_sessions INT DEFAULT 1,
      listing_count INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      deactivated_at TIMESTAMPTZ,
      deactivated_by VARCHAR(200),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `
},
{
  name: '048_listings_lat_lng_fix',
  sql: `
    ALTER TABLE public_listings
      ADD COLUMN IF NOT EXISTS lat DECIMAL(10,7),
      ADD COLUMN IF NOT EXISTS lng DECIMAL(10,7);
    CREATE INDEX IF NOT EXISTS idx_public_listings_loc ON public_listings(lat, lng) WHERE lat IS NOT NULL;
  `
},
{
  name: '049_user_locations',
  sql: `
    CREATE TABLE IF NOT EXISTS user_locations (
      guest_id   VARCHAR(50)  PRIMARY KEY,
      lat        DECIMAL(10,7) NOT NULL,
      lng        DECIMAL(10,7) NOT NULL,
      accuracy   DECIMAL(10,2),
      city       VARCHAR(100),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_user_locations_updated ON user_locations(updated_at);
    CREATE INDEX IF NOT EXISTS idx_user_locations_grid   ON user_locations(ROUND(lat::numeric,2), ROUND(lng::numeric,2));
  `
},
{
  name: '050_quick_search_cache',
  sql: `
    CREATE TABLE IF NOT EXISTS quick_search_cache (
      id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      lat_grid     DECIMAL(6,3) NOT NULL,
      lng_grid     DECIMAL(6,3) NOT NULL,
      category     VARCHAR(50)  NOT NULL,
      results      JSONB        DEFAULT '[]',
      result_count INT          DEFAULT 0,
      source       VARCHAR(20)  DEFAULT 'db',
      ai_enriched  BOOLEAN      DEFAULT FALSE,
      expires_at   TIMESTAMPTZ  DEFAULT NOW() + INTERVAL '2 hours',
      created_at   TIMESTAMPTZ  DEFAULT NOW(),
      updated_at   TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_qsc_key     ON quick_search_cache(lat_grid, lng_grid, category);
    CREATE INDEX        IF NOT EXISTS idx_qsc_grid    ON quick_search_cache(lat_grid, lng_grid);
    CREATE INDEX        IF NOT EXISTS idx_qsc_expires ON quick_search_cache(expires_at);
  `
},
{
  name: '051_ai_usage_logs',
  sql: `
    CREATE TABLE IF NOT EXISTS ai_usage_logs (
      id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      feature           VARCHAR(100) NOT NULL,
      agent_name        VARCHAR(100),
      pipeline_run_id   UUID,
      model             VARCHAR(100) NOT NULL,
      prompt_tokens     INT          DEFAULT 0,
      completion_tokens INT          DEFAULT 0,
      latency_ms        INT,
      status            VARCHAR(20)  DEFAULT 'success',
      error_msg         TEXT,
      tenant_id         UUID,
      store_id          UUID,
      metadata          JSONB        DEFAULT '{}',
      created_at        TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_logs_feature  ON ai_usage_logs(feature, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_logs_pipeline ON ai_usage_logs(pipeline_run_id);
    CREATE INDEX IF NOT EXISTS idx_ai_logs_tenant   ON ai_usage_logs(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_logs_created  ON ai_usage_logs(created_at DESC);
  `
},
{
  name: '052_ai_pipeline_runs',
  sql: `
    CREATE TABLE IF NOT EXISTS ai_pipeline_runs (
      id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id        UUID,
      store_id         UUID,
      store_name       VARCHAR(200),
      triggered_by     UUID,
      status           VARCHAR(20)  DEFAULT 'running',
      agents_completed INT          DEFAULT 0,
      agents_total     INT          DEFAULT 6,
      total_tokens     INT          DEFAULT 0,
      result           JSONB,
      error            TEXT,
      started_at       TIMESTAMPTZ  DEFAULT NOW(),
      completed_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_tenant  ON ai_pipeline_runs(tenant_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pipeline_started ON ai_pipeline_runs(started_at DESC);
  `
},
{
  name: '053_fill_default_categories',
  sql: `
    DO $$
    DECLARE
      t_record RECORD;
    BEGIN
      FOR t_record IN SELECT id FROM tenants LOOP
        INSERT INTO categories (id, tenant_id, name, code, description)
        VALUES (uuid_generate_v4(), t_record.id, 'Pharma', 'PHARMA', 'Pharmaceutical & medicines')
        ON CONFLICT (tenant_id, name) DO NOTHING;

        INSERT INTO categories (id, tenant_id, name, code, description)
        VALUES (uuid_generate_v4(), t_record.id, 'Groceries', 'GROCERY', 'General groceries & food items')
        ON CONFLICT (tenant_id, name) DO NOTHING;

        INSERT INTO categories (id, tenant_id, name, code, description)
        VALUES (uuid_generate_v4(), t_record.id, 'Autoparts', 'AUTOPARTS', 'Automotive spare parts & components')
        ON CONFLICT (tenant_id, name) DO NOTHING;
      END LOOP;
    END $$;
  `
    },
    {
      name: '054_discount_and_whatsapp_subscription',
      sql: `
        -- Add discount columns to items if they do not exist
        ALTER TABLE items ADD COLUMN IF NOT EXISTS discount_type VARCHAR(50) DEFAULT 'none';
        ALTER TABLE items ADD COLUMN IF NOT EXISTS discount_value DECIMAL(10,2) DEFAULT 0;

        -- Create whatsapp_subscriptions table
        CREATE TABLE IF NOT EXISTS whatsapp_subscriptions (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          phone VARCHAR(30) NOT NULL UNIQUE,
          verification_code VARCHAR(10),
          code_expires_at TIMESTAMPTZ,
          is_verified BOOLEAN DEFAULT FALSE,
          guest_id VARCHAR(50),
          user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `
    },
    {
      name: '055_coupons',
      sql: `
        CREATE TABLE IF NOT EXISTS coupons (
          id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          store_id         UUID REFERENCES stores(id) ON DELETE SET NULL,
          code             VARCHAR(30) NOT NULL,
          description      TEXT,
          discount_type    VARCHAR(20) NOT NULL CHECK (discount_type IN ('percentage','fixed')),
          discount_value   DECIMAL(10,2) NOT NULL,
          min_order_value  DECIMAL(10,2) DEFAULT 0,
          max_discount     DECIMAL(10,2),
          usage_limit      INT,
          valid_from       TIMESTAMPTZ,
          valid_to         TIMESTAMPTZ,
          is_active        BOOLEAN DEFAULT TRUE,
          created_by       UUID,
          created_at       TIMESTAMPTZ DEFAULT NOW(),
          updated_at       TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(tenant_id, code)
        );
        CREATE INDEX IF NOT EXISTS idx_coupons_tenant ON coupons(tenant_id, is_active);
        CREATE INDEX IF NOT EXISTS idx_coupons_code   ON coupons(UPPER(code));

        CREATE TABLE IF NOT EXISTS coupon_usages (
          id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          coupon_id  UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
          sale_id    UUID,
          user_id    UUID,
          used_at    TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_coupon_usages_coupon ON coupon_usages(coupon_id);

        ALTER TABLE sales ADD COLUMN IF NOT EXISTS coupon_id UUID REFERENCES coupons(id) ON DELETE SET NULL;
      `
    },
    {
      name: '056_hotel_outreaches',
      sql: `
        CREATE TABLE IF NOT EXISTS hotel_outreaches (
          id                 UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
          token              UUID         UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
          inquiry_id         TEXT         NOT NULL,
          hotel_name         TEXT         NOT NULL,
          hotel_email        TEXT,
          hotel_phone        TEXT,
          city               TEXT,
          inquiry_snapshot   JSONB        NOT NULL DEFAULT '{}',
          status             TEXT         NOT NULL DEFAULT 'Sent'
                                          CHECK (status IN ('Sent','Viewed','Responded')),
          hotel_action       TEXT         CHECK (hotel_action IN ('Accept','Quote','Hold','Reject','Future')),
          hotel_quote        NUMERIC(12,2),
          hotel_message      TEXT,
          hotel_contact_name TEXT,
          responded_at       TIMESTAMPTZ,
          created_at         TIMESTAMPTZ  DEFAULT NOW(),
          updated_at         TIMESTAMPTZ  DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_hotel_outreaches_token      ON hotel_outreaches(token);
        CREATE INDEX IF NOT EXISTS idx_hotel_outreaches_inquiry_id ON hotel_outreaches(inquiry_id);
      `
    },
    {
      name: '057_vendor_leads_columns',
      sql: `
        ALTER TABLE public_listings
          ALTER COLUMN phone DROP NOT NULL,
          ADD COLUMN IF NOT EXISTS email      VARCHAR(200),
          ADD COLUMN IF NOT EXISTS website    VARCHAR(500),
          ADD COLUMN IF NOT EXISTS pincode    VARCHAR(20),
          ADD COLUMN IF NOT EXISTS source     VARCHAR(30) DEFAULT 'manual',
          ADD COLUMN IF NOT EXISTS is_verified BOOLEAN    DEFAULT FALSE;
        CREATE INDEX IF NOT EXISTS idx_public_listings_source   ON public_listings(source);
        CREATE INDEX IF NOT EXISTS idx_public_listings_verified ON public_listings(is_verified);
      `
    },
    {
      name: '058_workflow_notifications',
      sql: `
        -- Workflow requests: booking/inquiry from a seeker
        CREATE TABLE IF NOT EXISTS workflow_requests (
          id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
          type          VARCHAR(50)  NOT NULL DEFAULT 'booking',
          title         TEXT         NOT NULL,
          description   TEXT,
          city          VARCHAR(100),
          vendor_type   VARCHAR(100),
          date_start    DATE,
          date_end      DATE,
          budget        NUMERIC(12,2),
          seeker_name   VARCHAR(200),
          seeker_phone  VARCHAR(30),
          seeker_email  VARCHAR(200),
          status        VARCHAR(50)  NOT NULL DEFAULT 'pending',
          matched_count INT          DEFAULT 0,
          notes         TEXT,
          created_at    TIMESTAMPTZ  DEFAULT NOW(),
          updated_at    TIMESTAMPTZ  DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_wf_req_phone  ON workflow_requests(seeker_phone);
        CREATE INDEX IF NOT EXISTS idx_wf_req_status ON workflow_requests(status);
        CREATE INDEX IF NOT EXISTS idx_wf_req_type   ON workflow_requests(vendor_type, city);

        -- Vendors matched and notified for each request
        CREATE TABLE IF NOT EXISTS workflow_vendor_matches (
          id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
          request_id      UUID         NOT NULL REFERENCES workflow_requests(id) ON DELETE CASCADE,
          vendor_type     VARCHAR(20)  NOT NULL DEFAULT 'listing',
          vendor_id       TEXT         NOT NULL,
          vendor_name     VARCHAR(200),
          vendor_phone    VARCHAR(30),
          vendor_city     VARCHAR(100),
          wa_notified_at  TIMESTAMPTZ,
          status          VARCHAR(50)  NOT NULL DEFAULT 'pending',
          notes           TEXT,
          quote_amount    NUMERIC(12,2),
          responded_at    TIMESTAMPTZ,
          created_at      TIMESTAMPTZ  DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_wf_match_request ON workflow_vendor_matches(request_id);
        CREATE INDEX IF NOT EXISTS idx_wf_match_phone   ON workflow_vendor_matches(vendor_phone);
        CREATE INDEX IF NOT EXISTS idx_wf_match_status  ON workflow_vendor_matches(status);

        -- In-app notifications (phone-based, works for both logged-in and public users)
        CREATE TABLE IF NOT EXISTS notifications (
          id           UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
          phone        VARCHAR(30),
          type         VARCHAR(50)  NOT NULL,
          title        TEXT         NOT NULL,
          body         TEXT,
          action_type  VARCHAR(50),
          action_data  JSONB        DEFAULT '{}',
          ref_type     VARCHAR(50),
          ref_id       TEXT,
          is_read      BOOLEAN      DEFAULT FALSE,
          read_at      TIMESTAMPTZ,
          created_at   TIMESTAMPTZ  DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_notif_phone  ON notifications(phone);
        CREATE INDEX IF NOT EXISTS idx_notif_read   ON notifications(phone, is_read);
        CREATE INDEX IF NOT EXISTS idx_notif_ref    ON notifications(ref_type, ref_id);
      `
    },
  ];
}
