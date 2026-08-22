const fs = require('fs');
let c = fs.readFileSync('backend/src/config/db.ts', 'utf8');

const mig = `    },
    {
      name: '103_erp_sales_pipeline_and_accounting_phase2',
      sql: \`
        ALTER TABLE items ADD COLUMN IF NOT EXISTS valuation_method VARCHAR(50) DEFAULT 'Weighted Average';
        ALTER TABLE items ADD COLUMN IF NOT EXISTS expiry_tracked BOOLEAN DEFAULT false;
        ALTER TABLE items ADD COLUMN IF NOT EXISTS hsn_sac_code VARCHAR(50);

        CREATE TABLE IF NOT EXISTS posting_rules (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          transaction_type VARCHAR(50) NOT NULL,
          debit_account_ref VARCHAR(255),
          credit_account_ref VARCHAR(255),
          notes TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(tenant_id, transaction_type)
        );

        CREATE TABLE IF NOT EXISTS leads (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
          customer_name VARCHAR(255) NOT NULL,
          company_name VARCHAR(255),
          phone VARCHAR(50),
          email VARCHAR(255),
          status VARCHAR(50) DEFAULT 'New',
          source VARCHAR(100),
          value NUMERIC(15,2),
          notes TEXT,
          assigned_to UUID REFERENCES users(id),
          created_by UUID REFERENCES users(id),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS quotations (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
          lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
          quote_number VARCHAR(100) NOT NULL,
          customer_name VARCHAR(255),
          customer_email VARCHAR(255),
          customer_phone VARCHAR(50),
          issue_date DATE NOT NULL,
          valid_until DATE,
          subtotal NUMERIC(15,2) DEFAULT 0,
          discount_amount NUMERIC(15,2) DEFAULT 0,
          gst_amount NUMERIC(15,2) DEFAULT 0,
          total_amount NUMERIC(15,2) DEFAULT 0,
          status VARCHAR(50) DEFAULT 'Draft',
          notes TEXT,
          terms TEXT,
          created_by UUID REFERENCES users(id),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS quotation_items (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          quotation_id UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
          item_id UUID REFERENCES items(id) ON DELETE SET NULL,
          description TEXT,
          qty NUMERIC(15,3) NOT NULL,
          unit_price NUMERIC(15,2) NOT NULL,
          discount_pct NUMERIC(5,2) DEFAULT 0,
          gst_rate NUMERIC(5,2) DEFAULT 0,
          line_total NUMERIC(15,2) NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sales_orders (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
          quotation_id UUID REFERENCES quotations(id) ON DELETE SET NULL,
          order_number VARCHAR(100) NOT NULL,
          customer_name VARCHAR(255),
          customer_email VARCHAR(255),
          customer_phone VARCHAR(50),
          order_date DATE NOT NULL,
          expected_delivery DATE,
          subtotal NUMERIC(15,2) DEFAULT 0,
          discount_amount NUMERIC(15,2) DEFAULT 0,
          gst_amount NUMERIC(15,2) DEFAULT 0,
          total_amount NUMERIC(15,2) DEFAULT 0,
          status VARCHAR(50) DEFAULT 'Pending',
          notes TEXT,
          created_by UUID REFERENCES users(id),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS sales_order_items (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          sales_order_id UUID NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
          item_id UUID REFERENCES items(id) ON DELETE SET NULL,
          description TEXT,
          qty NUMERIC(15,3) NOT NULL,
          qty_fulfilled NUMERIC(15,3) DEFAULT 0,
          unit_price NUMERIC(15,2) NOT NULL,
          discount_pct NUMERIC(5,2) DEFAULT 0,
          gst_rate NUMERIC(5,2) DEFAULT 0,
          line_total NUMERIC(15,2) NOT NULL
        );

        ALTER TABLE sales ADD COLUMN IF NOT EXISTS sales_order_id UUID REFERENCES sales_orders(id) ON DELETE SET NULL;
      \``;

const endIndex = c.lastIndexOf("  ];");
const newContent = c.substring(0, endIndex - 7) + mig + "\n    }\n" + c.substring(endIndex);
fs.writeFileSync('backend/src/config/db.ts', newContent);
console.log("Migration appended.");
