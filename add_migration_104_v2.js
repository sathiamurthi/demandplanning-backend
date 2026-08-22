const fs = require('fs');

let c = fs.readFileSync('backend/src/config/db.ts', 'utf8');

const migration104 = `
    ,{
      name: '104_standard_unit_types',
      sql: \`
        ALTER TABLE unit_types ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
        ALTER TABLE unit_types DROP CONSTRAINT IF EXISTS unit_types_name_key;
        ALTER TABLE unit_types DROP CONSTRAINT IF EXISTS unit_types_symbol_key;
        
        -- Seed standard units (tenant_id IS NULL)
        INSERT INTO unit_types (name, symbol, category) VALUES
          ('Piece','pc','count'),('Dozen','doz','count'),('Strip','strip','count'),
          ('Box','box','count'),('Carton','ctn','count'),('Pack','pack','count'),
          ('Kilogram','kg','weight'),('Gram','g','weight'),('Milligram','mg','weight'),
          ('Tonne','tn','weight'),('Litre','L','volume'),('Millilitre','mL','volume'),
          ('Metre','m','length'),('Centimetre','cm','length'),
          ('Tablet', 'tab', 'count'), ('Capsule', 'cap', 'count'), ('Bottle', 'btl', 'count'),
          ('Tube', 'tube', 'count'), ('Vial', 'vial', 'count'), ('Ampoule', 'amp', 'count'),
          ('Liter', 'L', 'volume'), ('Milliliter', 'mL', 'volume'), ('Packet', 'pkt', 'count'),
          ('Pouch', 'pch', 'count'), ('Bunch', 'bunch', 'count'), ('Set', 'set', 'count'),
          ('Kit', 'kit', 'count'), ('Pair', 'pair', 'count'), ('Gallon', 'gal', 'volume'),
          ('Crate', 'crate', 'count'), ('Pallet', 'plt', 'count'), ('Bag', 'bag', 'count'),
          ('Sack', 'sack', 'count'), ('Drum', 'drum', 'count')
        ON CONFLICT DO NOTHING;
      \`
    }
  ];
}
`;

c = c.replace(/  \];\n\}\s*$/, migration104);

fs.writeFileSync('backend/src/config/db.ts', c);
console.log('Added migration 104');
