// ============================================================
// UNITS ROUTER
// ============================================================

import { Router } from 'express';
import { query } from '../../config/db';

const router = Router();

const ok = (res: any, data: any) =>
  res.json({ success: true, data });

const fail = (res: any, msg: string) =>
  res.status(400).json({ success: false, error: msg });

// ============================================================
// GET ALL UNITS
// ============================================================
router.get('/', async (_req, res) => {
  try {
    const units = await query(
      `SELECT * FROM unit_types WHERE tenant_id IS NULL OR tenant_id = $1 ORDER BY name", [(req as any).user.tenantId]`
    );
    ok(res, units);
  } catch (e: any) {
    fail(res, e.message);
  }
});


// ============================================================
// CREATE UNIT
// ============================================================
router.post('/', async (req, res) => {
  try {
    const { name, symbol, category, is_active } = req.body;
    const result = await query(
      `INSERT INTO unit_types (name, symbol, category, is_active, tenant_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
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
      `UPDATE unit_types 
       SET name=$1, symbol=$2, category=$3, is_active=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
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
    await query(`DELETE FROM unit_types WHERE id=$1`, [id]);
    ok(res, { deleted: true });
  } catch (e: any) {
    fail(res, e.message);
  }
});

export const unitsRouter = router;