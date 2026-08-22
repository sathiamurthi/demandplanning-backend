const fs = require('fs');

let c = fs.readFileSync('scripts/seed-e2e.ts', 'utf8');
c = c.replace(
  "INSERT INTO tenants (name, sub_domain, industry, is_active) \n      VALUES ('E2E Test Tenant', 'e2e-test', 'Retail', true)",
  "INSERT INTO tenants (name, slug, industry_id) \n      VALUES ('E2E Test Tenant', 'e2e-test', 'retail')"
);

fs.writeFileSync('scripts/seed-e2e.ts', c);
console.log('Fixed seed');
