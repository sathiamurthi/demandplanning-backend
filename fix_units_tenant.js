const fs = require('fs');

// 1. Update app.ts
let appTs = fs.readFileSync('backend/src/app.ts', 'utf8');
appTs = appTs.replace(
  "app.use('/v1/units',      unitsRouter);",
  "app.use('/v1/units',      authMiddleware, unitsRouter);"
);
fs.writeFileSync('backend/src/app.ts', appTs);

// 2. Update units.service.ts
let unitsTs = fs.readFileSync('backend/src/modules/auth/units.service.ts', 'utf8');
unitsTs = unitsTs.replace(
  "SELECT * FROM unit_types ORDER BY name",
  "SELECT * FROM unit_types WHERE tenant_id IS NULL OR tenant_id = $1 ORDER BY name\", [(req as any).user.tenantId]"
);

// For POST, add tenant_id
unitsTs = unitsTs.replace(
  "INSERT INTO unit_types (name, symbol, category, is_active)",
  "INSERT INTO unit_types (name, symbol, category, is_active, tenant_id)"
);
unitsTs = unitsTs.replace(
  "VALUES ($1, $2, $3, $4) RETURNING *\",\n      [name, symbol, category || 'count', is_active ?? true]",
  "VALUES ($1, $2, $3, $4, $5) RETURNING *\",\n      [name, symbol, category || 'count', is_active ?? true, (req as any).user.tenantId]"
);

// For PUT, only update if tenant_id matches
unitsTs = unitsTs.replace(
  "WHERE id=$5 RETURNING *\",\n      [name, symbol, category, is_active, id]",
  "WHERE id=$5 AND tenant_id=$6 RETURNING *\",\n      [name, symbol, category, is_active, id, (req as any).user.tenantId]"
);

// For DELETE, only delete if tenant_id matches
unitsTs = unitsTs.replace(
  "DELETE FROM unit_types WHERE id=$1\", [id]",
  "DELETE FROM unit_types WHERE id=$1 AND tenant_id=$2\", [id, (req as any).user.tenantId]"
);

fs.writeFileSync('backend/src/modules/auth/units.service.ts', unitsTs);
console.log('Fixed units service tenant isolation');
