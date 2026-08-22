const fs = require('fs');

const sql = `
        -- Double Entry Accounting & COA
        CREATE TABLE IF NOT EXISTS chart_of_accounts (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
          parent_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
          account_code VARCHAR(50),
          name VARCHAR(255) NOT NULL,
          account_type VARCHAR(50) NOT NULL, -- Asset, Liability, Equity, Revenue, Expense
          is_group BOOLEAN DEFAULT false,
          current_balance NUMERIC(15, 2) DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (tenant_id, store_id, name)
        );

        CREATE TABLE IF NOT EXISTS financial_years (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          name VARCHAR(100) NOT NULL,
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          is_closed BOOLEAN DEFAULT false,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(tenant_id, name)
        );

        CREATE TABLE IF NOT EXISTS journal_entries (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
          financial_year_id UUID REFERENCES financial_years(id) ON DELETE SET NULL,
          voucher_no VARCHAR(100),
          voucher_type VARCHAR(50) NOT NULL, -- Journal, Receipt, Payment, Contra, Sales, Purchase
          entry_date DATE NOT NULL,
          reference_type VARCHAR(50),
          reference_id UUID,
          narrative TEXT,
          status VARCHAR(20) DEFAULT 'posted',
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS journal_lines (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
          account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE CASCADE,
          debit NUMERIC(15, 2) DEFAULT 0,
          credit NUMERIC(15, 2) DEFAULT 0,
          narrative TEXT
        );
`;

const file = 'backend/src/config/db.ts';
let content = fs.readFileSync(file, 'utf-8');

const endArrIndex = content.lastIndexOf('];');
if (endArrIndex !== -1) {
  const injection = "\n    ,\n    {\n      name: '102_erp_accounting_phase1',\n      sql: `" + sql + "`\n    }\n  ";
  content = content.slice(0, endArrIndex) + injection + content.slice(endArrIndex);
  fs.writeFileSync(file, content);
  console.log('Migration injected!');
} else {
  console.log('Failed to find end of migrations array');
}
