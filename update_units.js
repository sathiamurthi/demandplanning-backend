const fs = require('fs');

let c = fs.readFileSync('backend/src/config/db.ts', 'utf8');

const newUnits = `
        INSERT INTO unit_types (name, symbol, category) VALUES
          ('Tablet', 'tab', 'count'), ('Capsule', 'cap', 'count'), ('Bottle', 'btl', 'count'),
          ('Tube', 'tube', 'count'), ('Vial', 'vial', 'count'), ('Ampoule', 'amp', 'count'),
          ('Liter', 'L', 'volume'), ('Milliliter', 'mL', 'volume'), ('Packet', 'pkt', 'count'),
          ('Pouch', 'pch', 'count'), ('Bunch', 'bunch', 'count'), ('Set', 'set', 'count'),
          ('Kit', 'kit', 'count'), ('Pair', 'pair', 'count'), ('Gallon', 'gal', 'volume'),
          ('Crate', 'crate', 'count'), ('Pallet', 'plt', 'count'), ('Bag', 'bag', 'count'),
          ('Sack', 'sack', 'count'), ('Drum', 'drum', 'count')
        ON CONFLICT DO NOTHING;
`;

// Insert the new units query right after the existing INSERT INTO unit_types
const insertIndex = c.indexOf("('Kilogram','kg','weight'),('Gram','g','weight'),('Milligram','mg','weight'),");
if (insertIndex > -1) {
  const endInsert = c.indexOf("ON CONFLICT DO NOTHING;", insertIndex);
  if (endInsert > -1) {
    c = c.substring(0, endInsert + 23) + newUnits + c.substring(endInsert + 23);
  }
}

// Add tenant_id to unit_types
const alterUnitTypes = `
        ALTER TABLE unit_types ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
        ALTER TABLE unit_types DROP CONSTRAINT IF EXISTS unit_types_name_key;
        ALTER TABLE unit_types DROP CONSTRAINT IF EXISTS unit_types_symbol_key;
`;

const triggerIndex = c.indexOf("CREATE TABLE IF NOT EXISTS items");
if (triggerIndex > -1) {
  c = c.substring(0, triggerIndex) + alterUnitTypes + c.substring(triggerIndex);
}

fs.writeFileSync('backend/src/config/db.ts', c);
console.log('Added standard units and tenant_id to unit_types');
