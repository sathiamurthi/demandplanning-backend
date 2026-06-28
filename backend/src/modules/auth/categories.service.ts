// ============================================================
// CATEGORIES MODULE — Full CQRS (hierarchical, per-tenant)
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../config/db';
import { commandBus, ICommand, ICommandHandler } from '../../cqrs/commandBus';
import { queryBus, IQuery, IQueryHandler } from '../../cqrs/queryBus';
import { authMiddleware } from '../auth/auth.service';
import { requireMinRole } from '../../core/guards/roleGuard';
import { requireTenantAccess } from '../../core/guards/roleGuard';
import { categoriesMap } from '../../config/default_categories';

function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}

// ── Commands ──────────────────────────────────────────────────

interface CreateCategoryCommand extends ICommand {
  readonly type: 'category.create';
  tenantId: string;
  name: string;
  code?: string;
  description?: string;
  parentId?: string;
  sortOrder?: number;
}

class CreateCategoryCommandHandler implements ICommandHandler<CreateCategoryCommand> {
  async execute(cmd: CreateCategoryCommand) {
    const exists = await queryOne(
      'SELECT id FROM categories WHERE tenant_id=$1 AND name=$2 AND is_active=TRUE',
      [cmd.tenantId, cmd.name]
    );
    if (exists) throw new Error(`Category "${cmd.name}" already exists`);

    // Validate parent exists in same tenant
    if (cmd.parentId) {
      const parent = await queryOne(
        'SELECT id FROM categories WHERE id=$1 AND tenant_id=$2',
        [cmd.parentId, cmd.tenantId]
      );
      if (!parent) throw new Error('Parent category not found');
    }

    const [cat] = await query<any>(
      `INSERT INTO categories (tenant_id, parent_id, name, code, description, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [cmd.tenantId, cmd.parentId || null, cmd.name, cmd.code || null,
       cmd.description || null, cmd.sortOrder || 0]
    );
    return cat;
  }
}

interface UpdateCategoryCommand extends ICommand {
  readonly type: 'category.update';
  categoryId: string;
  tenantId: string;
  name?: string;
  code?: string;
  description?: string;
  parentId?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

class UpdateCategoryCommandHandler implements ICommandHandler<UpdateCategoryCommand> {
  async execute(cmd: UpdateCategoryCommand) {
    // Prevent circular parent reference
    if (cmd.parentId) {
      if (cmd.parentId === cmd.categoryId) throw new Error('Category cannot be its own parent');
      // Check the parent is not a child of this category
      const children = await query<any>(
        `WITH RECURSIVE sub AS (
           SELECT id FROM categories WHERE parent_id=$1
           UNION ALL
           SELECT c.id FROM categories c JOIN sub ON c.parent_id=sub.id
         ) SELECT id FROM sub`,
        [cmd.categoryId]
      );
      if (children.some(c => c.id === cmd.parentId))
        throw new Error('Cannot set a child category as parent (circular reference)');
    }

    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (cmd.name !== undefined)      { sets.push(`name=$${i++}`);        vals.push(cmd.name); }
    if (cmd.code !== undefined)      { sets.push(`code=$${i++}`);        vals.push(cmd.code); }
    if (cmd.description !== undefined){ sets.push(`description=$${i++}`); vals.push(cmd.description); }
    if (cmd.parentId !== undefined)  { sets.push(`parent_id=$${i++}`);   vals.push(cmd.parentId); }
    if (cmd.sortOrder !== undefined) { sets.push(`sort_order=$${i++}`);  vals.push(cmd.sortOrder); }
    if (cmd.isActive !== undefined)  { sets.push(`is_active=$${i++}`);   vals.push(cmd.isActive); }
    if (!sets.length) throw new Error('Nothing to update');

    vals.push(cmd.categoryId, cmd.tenantId);
    const [cat] = await query<any>(
      `UPDATE categories SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i+1} RETURNING *`,
      vals
    );
    if (!cat) throw new Error('Category not found');
    return cat;
  }
}

interface DeleteCategoryCommand extends ICommand {
  readonly type: 'category.delete';
  categoryId: string;
  tenantId: string;
}

class DeleteCategoryCommandHandler implements ICommandHandler<DeleteCategoryCommand> {
  async execute(cmd: DeleteCategoryCommand) {
    // Check if any items use this category
    const itemCount = await queryOne<any>(
      'SELECT COUNT(*)::int as count FROM items WHERE category_id=$1 AND is_active=TRUE',
      [cmd.categoryId]
    );
    if ((itemCount?.count || 0) > 0) {
      throw new Error(`Cannot delete — ${itemCount?.count} item(s) using this category`);
    }
    // Deactivate children too
    await query(
      `UPDATE categories SET is_active=FALSE
       WHERE (id=$1 OR parent_id=$1) AND tenant_id=$2`,
      [cmd.categoryId, cmd.tenantId]
    );
    return { message: 'Category deleted', id: cmd.categoryId };
  }
}

interface ReorderCategoriesCommand extends ICommand {
  readonly type: 'category.reorder';
  tenantId: string;
  order: Array<{ id: string; sortOrder: number }>;
}

class ReorderCategoriesCommandHandler implements ICommandHandler<ReorderCategoriesCommand> {
  async execute(cmd: ReorderCategoriesCommand) {
    for (const item of cmd.order) {
      await query(
        'UPDATE categories SET sort_order=$1 WHERE id=$2 AND tenant_id=$3',
        [item.sortOrder, item.id, cmd.tenantId]
      );
    }
    return { updated: cmd.order.length };
  }
}

// ── Queries ───────────────────────────────────────────────────

interface ListCategoriesQuery extends IQuery {
  readonly type: 'category.list';
  tenantId: string;
  parentId?: string | null;  // null = top-level only, undefined = all
  includeInactive?: boolean;
  withItemCount?: boolean;
}

class ListCategoriesQueryHandler implements IQueryHandler<ListCategoriesQuery, any[]> {
  async execute(q: ListCategoriesQuery) {
    const conds = [`c.tenant_id=$1`];
    const vals: any[] = [q.tenantId]; let i = 2;
    if (!q.includeInactive) conds.push('c.is_active=TRUE');
    if (q.parentId === null) { conds.push('c.parent_id IS NULL'); }
    else if (q.parentId)     { conds.push(`c.parent_id=$${i++}`); vals.push(q.parentId); }

    const itemCountSql = q.withItemCount
      ? `(SELECT COUNT(*)::int FROM items WHERE category_id=c.id AND is_active=TRUE) as item_count,`
      : '';

    const childCountSql = `(SELECT COUNT(*)::int FROM categories WHERE parent_id=c.id AND is_active=TRUE) as child_count,`;

    const totalCount = await queryOne<any>(
      "SELECT COUNT(*)::int as count FROM categories WHERE tenant_id=$1",
      [q.tenantId]
    );

    if (totalCount?.count === 0) {
      const ind = await queryOne<any>(
        `SELECT ic.industry_id 
         FROM tenant_industries ti
         JOIN industry_configs ic ON ic.id = ti.industry_id
         WHERE ti.tenant_id = $1`,
        [q.tenantId]
      );
      const industry = ind?.industry_id || "retail";



      const defaultCategories = categoriesMap[industry] || [
        { name: "General", code: "GENERAL", desc: "Default category" }
      ];

      for (let j = 0; j < defaultCategories.length; j++) {
        const cat = defaultCategories[j];
        await query(
          `INSERT INTO categories (tenant_id, name, code, description, sort_order)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, name) DO NOTHING`,
          [q.tenantId, cat.name, cat.code, cat.desc, j]
        );
      }
    }

    return query<any>(
      `SELECT c.*, ${itemCountSql} ${childCountSql}
              p.name as parent_name
       FROM categories c
       LEFT JOIN categories p ON p.id=c.parent_id
       WHERE ${conds.join(' AND ')}
       ORDER BY c.sort_order ASC, c.name ASC`,
      vals
    );
  }
}

interface GetCategoryTreeQuery extends IQuery {
  readonly type: 'category.tree';
  tenantId: string;
}

class GetCategoryTreeQueryHandler implements IQueryHandler<GetCategoryTreeQuery, any[]> {
  async execute(q: GetCategoryTreeQuery) {
    // Recursive CTE to get full tree
    const rows = await query<any>(
      `WITH RECURSIVE tree AS (
         SELECT c.*, 0 as depth, c.name::text as path
         FROM categories c
         WHERE c.tenant_id=$1 AND c.parent_id IS NULL AND c.is_active=TRUE
         UNION ALL
         SELECT c.*, t.depth+1, t.path||' > '||c.name
         FROM categories c
         JOIN tree t ON c.parent_id=t.id
         WHERE c.is_active=TRUE
       )
       SELECT tree.*,
              (SELECT COUNT(*)::int FROM items WHERE category_id=tree.id AND is_active=TRUE) as item_count
       FROM tree
       ORDER BY path`,
      [q.tenantId]
    );

    // Nest into tree structure
    const map = new Map<string, any>();
    rows.forEach(r => { map.set(r.id, { ...r, children: [] }); });
    const roots: any[] = [];
    rows.forEach(r => {
      if (r.parent_id && map.has(r.parent_id)) {
        map.get(r.parent_id).children.push(map.get(r.id));
      } else {
        roots.push(map.get(r.id));
      }
    });
    return roots;
  }
}

interface GetCategoryQuery extends IQuery {
  readonly type: 'category.get';
  categoryId: string;
  tenantId: string;
}

class GetCategoryQueryHandler implements IQueryHandler<GetCategoryQuery, any> {
  async execute(q: GetCategoryQuery) {
    const cat = await queryOne<any>(
      `SELECT c.*,
              p.name as parent_name,
              (SELECT COUNT(*)::int FROM items WHERE category_id=c.id AND is_active=TRUE) as item_count,
              (SELECT COUNT(*)::int FROM categories WHERE parent_id=c.id AND is_active=TRUE) as child_count
       FROM categories c
       LEFT JOIN categories p ON p.id=c.parent_id
       WHERE c.id=$1 AND c.tenant_id=$2`,
      [q.categoryId, q.tenantId]
    );
    if (!cat) throw new Error('Category not found');
    return cat;
  }
}

// ── Register ──────────────────────────────────────────────────
commandBus.register('category.create',  new CreateCategoryCommandHandler());
commandBus.register('category.update',  new UpdateCategoryCommandHandler());
commandBus.register('category.delete',  new DeleteCategoryCommandHandler());
commandBus.register('category.reorder', new ReorderCategoriesCommandHandler());
queryBus.register('category.list',      new ListCategoriesQueryHandler());
queryBus.register('category.tree',      new GetCategoryTreeQueryHandler());
queryBus.register('category.get',       new GetCategoryQueryHandler());

// ── Validation ─────────────────────────────────────────────────
const CreateCategorySchema = z.object({
  name: z.string().min(1).max(100),
  code: z.string().max(50).optional(),
  description: z.string().optional(),
  parentId: z.string().uuid().optional(),
  sortOrder: z.number().int().optional(),
});

const UpdateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  code: z.string().max(50).optional(),
  description: z.string().optional(),
  parentId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

// ── Router ─────────────────────────────────────────────────────
export const categoryRouter = Router({ mergeParams: true });
categoryRouter.use(authMiddleware);
categoryRouter.use(requireTenantAccess());

// GET /v1/tenants/:tenantId/categories
categoryRouter.get('/', async (req, res) => {
  try {
    const tenantId = (req.params as any).tenantId;

    const r = await queryBus.execute<any>({
      type: 'category.list',
      tenantId: tenantId,
      parentId: req.query.parentId === 'null' ? null : req.query.parentId as string,
      includeInactive: req.query.includeInactive === 'true',
      withItemCount: req.query.withItemCount === 'true',
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// GET /v1/tenants/:tenantId/categories/tree
categoryRouter.get('/tree', async (req, res) => {
  try {
    const tenantId = (req.params as any).tenantId;

    const r = await queryBus.execute<any>({ type: 'category.tree', tenantId: tenantId });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// GET /v1/tenants/:tenantId/categories/:id
categoryRouter.get('/:id', async (req, res) => {
  try {
    const tenantId = (req.params as any).tenantId;

    const r = await queryBus.execute<any>({
      type: 'category.get', categoryId: req.params.id, tenantId: tenantId
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message, 404); }
});

// POST /v1/tenants/:tenantId/categories
categoryRouter.post('/', requireMinRole('manager'), async (req, res) => {
  try {
    const body = CreateCategorySchema.parse(req.body);
    const r = await commandBus.execute<any>({
      type: 'category.create', tenantId: req.params.tenantId, ...body
    });
    ok(res, r, 201);
  } catch (e: any) { fail(res, e.message); }
});

// PUT /v1/tenants/:tenantId/categories/reorder
categoryRouter.put('/reorder', requireMinRole('manager'), async (req, res) => {
  try {
    const { order } = z.object({
      order: z.array(z.object({ id: z.string().uuid(), sortOrder: z.number().int() }))
    }).parse(req.body);
    const r = await commandBus.execute<any>({
      type: 'category.reorder', tenantId: req.params.tenantId, order
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// PUT /v1/tenants/:tenantId/categories/:id
categoryRouter.put('/:id', requireMinRole('manager'), async (req, res) => {
  try {
    const body = UpdateCategorySchema.parse(req.body);
    const r = await commandBus.execute<any>({
      type: 'category.update', categoryId: req.params.id, tenantId: req.params.tenantId, ...body
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// DELETE /v1/tenants/:tenantId/categories/:id
categoryRouter.delete('/:id', requireMinRole('manager'), async (req, res) => {
  try {
    const r = await commandBus.execute<any>({
      type: 'category.delete', categoryId: req.params.id, tenantId: req.params.tenantId
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});