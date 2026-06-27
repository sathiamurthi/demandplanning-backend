import { Request, Response } from "express";


import {
  updateEntity,
  deleteEntity,
} from "../services/generic";
import { createEntity, getEntities } from "./entityservice";

/* ================= HELPERS ================= */

function getString(value: unknown): string {
  if (Array.isArray(value)) return value[0];
  return value as string;
}

/* ================= GET ALL ================= */

export async function getAll(req: Request, res: Response) {
   try {
    const entity = req.params.entity as string // must match case labels
    const tenantId = (req as any).user?.tenantId as string;

    if (!tenantId) {
      return res.status(400).json({ success: false, error: "tenantId required" });
    }

    const result = await getEntities(entity, tenantId, req.body);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}


export async function update(req: Request, res: Response) {
  const entity = getString(req.params.entity);
  const id = getString(req.params.id);
  const tenantId = (req as any).user.tenantId as string;

  const result = await updateEntity(
    entity,
    tenantId,   // ✅ keep tenant scope
    req.body
  );

  res.json({ success: true, data: result });
}

export async function remove(req: Request, res: Response) {
  const entity = getString(req.params.entity);
  const id = getString(req.params.id);
  const tenantId = (req as any).user.tenantId as string;

  await deleteEntity(
    entity,
    tenantId,   // ✅ important for multi-tenant safety
    id
  );

  res.json({ success: true });
}



export async function create(req: Request, res: Response) {
  try {
    const entity = req.params.entity as string // must match case labels
    const tenantId = (req as any).user?.tenantId as string;

    if (!tenantId) {
      return res.status(400).json({ success: false, error: "tenantId required" });
    }

    const result = await createEntity(entity, tenantId, req.body);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

