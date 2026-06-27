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
      `SELECT * FROM unit_types WHERE is_active=TRUE ORDER BY name`
    );
    ok(res, units);
  } catch (e: any) {
    fail(res, e.message);
  }
});

export const unitsRouter = router;