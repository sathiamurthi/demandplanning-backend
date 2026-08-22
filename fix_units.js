const fs = require('fs');

let c = fs.readFileSync('backend/src/modules/auth/units.service.ts', 'utf8');

const crud = `
// ============================================================
// CREATE UNIT
// ============================================================
router.post('/', async (req, res) => {
  try {
    const { name, symbol, category, is_active } = req.body;
    const result = await query(
      \`INSERT INTO unit_types (name, symbol, category, is_active)
       VALUES ($1, $2, $3, $4) RETURNING *\`,
      [name, symbol, category || 'count', is_active ?? true]
    );
    ok(res, result[0]);
  } catch (e: any) {
    fail(res, e.message);
  }
});

// ============================================================
// UPDATE UNIT
// ============================================================
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, symbol, category, is_active } = req.body;
    const result = await query(
      \`UPDATE unit_types 
       SET name=$1, symbol=$2, category=$3, is_active=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *\`,
      [name, symbol, category, is_active, id]
    );
    ok(res, result[0]);
  } catch (e: any) {
    fail(res, e.message);
  }
});

// ============================================================
// DELETE UNIT
// ============================================================
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await query(\`DELETE FROM unit_types WHERE id=$1\`, [id]);
    ok(res, { deleted: true });
  } catch (e: any) {
    fail(res, e.message);
  }
});
`;

c = c.replace('export const unitsRouter = router;', crud + '\nexport const unitsRouter = router;');

// Wait, the GET ALL should probably NOT filter by is_active=TRUE if we are managing them!
c = c.replace('SELECT * FROM unit_types WHERE is_active=TRUE ORDER BY name', 'SELECT * FROM unit_types ORDER BY name');

fs.writeFileSync('backend/src/modules/auth/units.service.ts', c);
console.log('units.service.ts updated');
