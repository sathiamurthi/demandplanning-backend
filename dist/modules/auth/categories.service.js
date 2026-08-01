"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.categoryRouter = void 0;
// ============================================================
// CATEGORIES MODULE — Full CQRS (hierarchical, per-tenant)
// ============================================================
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const commandBus_1 = require("../../cqrs/commandBus");
const queryBus_1 = require("../../cqrs/queryBus");
const auth_service_1 = require("../auth/auth.service");
const roleGuard_1 = require("../../core/guards/roleGuard");
const roleGuard_2 = require("../../core/guards/roleGuard");
const default_categories_1 = require("../../config/default_categories");
async function seedCategories(tenantId, cats) {
    for (let j = 0; j < cats.length; j++) {
        const cat = cats[j];
        await (0, db_1.query)(`INSERT INTO categories (tenant_id, name, code, description, sort_order)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, name) DO NOTHING`, [tenantId, cat.name, cat.code, cat.desc, j]);
    }
}
function ok(res, data, status = 200) {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res, msg, status = 400) {
    res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}
class CreateCategoryCommandHandler {
    async execute(cmd) {
        const exists = await (0, db_1.queryOne)('SELECT id FROM categories WHERE tenant_id=$1 AND name=$2 AND is_active=TRUE', [cmd.tenantId, cmd.name]);
        if (exists)
            throw new Error(`Category "${cmd.name}" already exists`);
        // Validate parent exists in same tenant
        if (cmd.parentId) {
            const parent = await (0, db_1.queryOne)('SELECT id FROM categories WHERE id=$1 AND tenant_id=$2', [cmd.parentId, cmd.tenantId]);
            if (!parent)
                throw new Error('Parent category not found');
        }
        const [cat] = await (0, db_1.query)(`INSERT INTO categories (tenant_id, parent_id, name, code, description, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [cmd.tenantId, cmd.parentId || null, cmd.name, cmd.code || null,
            cmd.description || null, cmd.sortOrder || 0]);
        return cat;
    }
}
class UpdateCategoryCommandHandler {
    async execute(cmd) {
        // Prevent circular parent reference
        if (cmd.parentId) {
            if (cmd.parentId === cmd.categoryId)
                throw new Error('Category cannot be its own parent');
            // Check the parent is not a child of this category
            const children = await (0, db_1.query)(`WITH RECURSIVE sub AS (
           SELECT id FROM categories WHERE parent_id=$1
           UNION ALL
           SELECT c.id FROM categories c JOIN sub ON c.parent_id=sub.id
         ) SELECT id FROM sub`, [cmd.categoryId]);
            if (children.some(c => c.id === cmd.parentId))
                throw new Error('Cannot set a child category as parent (circular reference)');
        }
        const sets = [];
        const vals = [];
        let i = 1;
        if (cmd.name !== undefined) {
            sets.push(`name=$${i++}`);
            vals.push(cmd.name);
        }
        if (cmd.code !== undefined) {
            sets.push(`code=$${i++}`);
            vals.push(cmd.code);
        }
        if (cmd.description !== undefined) {
            sets.push(`description=$${i++}`);
            vals.push(cmd.description);
        }
        if (cmd.parentId !== undefined) {
            sets.push(`parent_id=$${i++}`);
            vals.push(cmd.parentId);
        }
        if (cmd.sortOrder !== undefined) {
            sets.push(`sort_order=$${i++}`);
            vals.push(cmd.sortOrder);
        }
        if (cmd.isActive !== undefined) {
            sets.push(`is_active=$${i++}`);
            vals.push(cmd.isActive);
        }
        if (!sets.length)
            throw new Error('Nothing to update');
        vals.push(cmd.categoryId, cmd.tenantId);
        const [cat] = await (0, db_1.query)(`UPDATE categories SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i + 1} RETURNING *`, vals);
        if (!cat)
            throw new Error('Category not found');
        return cat;
    }
}
class DeleteCategoryCommandHandler {
    async execute(cmd) {
        // Check if any items use this category
        const itemCount = await (0, db_1.queryOne)('SELECT COUNT(*)::int as count FROM items WHERE category_id=$1 AND is_active=TRUE', [cmd.categoryId]);
        if ((itemCount?.count || 0) > 0) {
            throw new Error(`Cannot delete — ${itemCount?.count} item(s) using this category`);
        }
        // Deactivate children too
        await (0, db_1.query)(`UPDATE categories SET is_active=FALSE
       WHERE (id=$1 OR parent_id=$1) AND tenant_id=$2`, [cmd.categoryId, cmd.tenantId]);
        return { message: 'Category deleted', id: cmd.categoryId };
    }
}
class ReorderCategoriesCommandHandler {
    async execute(cmd) {
        for (const item of cmd.order) {
            await (0, db_1.query)('UPDATE categories SET sort_order=$1 WHERE id=$2 AND tenant_id=$3', [item.sortOrder, item.id, cmd.tenantId]);
        }
        return { updated: cmd.order.length };
    }
}
class ListCategoriesQueryHandler {
    async execute(q) {
        const conds = [`c.tenant_id=$1`];
        const vals = [q.tenantId];
        let i = 2;
        if (!q.includeInactive)
            conds.push('c.is_active=TRUE');
        if (q.parentId === null) {
            conds.push('c.parent_id IS NULL');
        }
        else if (q.parentId) {
            conds.push(`c.parent_id=$${i++}`);
            vals.push(q.parentId);
        }
        const itemCountSql = q.withItemCount
            ? `(SELECT COUNT(*)::int FROM items WHERE category_id=c.id AND is_active=TRUE) as item_count,`
            : '';
        const childCountSql = `(SELECT COUNT(*)::int FROM categories WHERE parent_id=c.id AND is_active=TRUE) as child_count,`;
        const totalCount = await (0, db_1.queryOne)("SELECT COUNT(*)::int as count, COUNT(*) FILTER (WHERE code='GENERAL')::int as generic_count FROM categories WHERE tenant_id=$1", [q.tenantId]);
        // Re-seed when there are no categories at all, OR when the only category
        // present is the old generic "General" fallback (a symptom of the
        // industry not having been resolved correctly at registration time) —
        // in that case a correct industry match should replace the placeholder.
        const needsSeed = totalCount?.count === 0 || (totalCount?.count === 1 && totalCount?.generic_count === 1);
        if (needsSeed) {
            const ind = await (0, db_1.queryOne)(`SELECT ic.industry_id
         FROM tenant_industries ti
         JOIN industry_configs ic ON ic.id = ti.industry_id
         WHERE ti.tenant_id = $1`, [q.tenantId]);
            const industryKey = (0, default_categories_1.resolveCategoryKey)(ind?.industry_id);
            const defaultCategories = default_categories_1.categoriesMap[industryKey];
            if (defaultCategories) {
                if (totalCount?.generic_count === 1) {
                    await (0, db_1.query)(`DELETE FROM categories WHERE tenant_id=$1 AND code='GENERAL'`, [q.tenantId]);
                }
                await seedCategories(q.tenantId, defaultCategories);
            }
            else if (totalCount?.count === 0) {
                await seedCategories(q.tenantId, [{ name: "General", code: "GENERAL", desc: "Default category" }]);
            }
        }
        return (0, db_1.query)(`SELECT c.*, ${itemCountSql} ${childCountSql}
              p.name as parent_name
       FROM categories c
       LEFT JOIN categories p ON p.id=c.parent_id
       WHERE ${conds.join(' AND ')}
       ORDER BY c.sort_order ASC, c.name ASC`, vals);
    }
}
class GetCategoryTreeQueryHandler {
    async execute(q) {
        // Recursive CTE to get full tree
        const rows = await (0, db_1.query)(`WITH RECURSIVE tree AS (
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
       ORDER BY path`, [q.tenantId]);
        // Nest into tree structure
        const map = new Map();
        rows.forEach(r => { map.set(r.id, { ...r, children: [] }); });
        const roots = [];
        rows.forEach(r => {
            if (r.parent_id && map.has(r.parent_id)) {
                map.get(r.parent_id).children.push(map.get(r.id));
            }
            else {
                roots.push(map.get(r.id));
            }
        });
        return roots;
    }
}
class GetCategoryQueryHandler {
    async execute(q) {
        const cat = await (0, db_1.queryOne)(`SELECT c.*,
              p.name as parent_name,
              (SELECT COUNT(*)::int FROM items WHERE category_id=c.id AND is_active=TRUE) as item_count,
              (SELECT COUNT(*)::int FROM categories WHERE parent_id=c.id AND is_active=TRUE) as child_count
       FROM categories c
       LEFT JOIN categories p ON p.id=c.parent_id
       WHERE c.id=$1 AND c.tenant_id=$2`, [q.categoryId, q.tenantId]);
        if (!cat)
            throw new Error('Category not found');
        return cat;
    }
}
// ── Register ──────────────────────────────────────────────────
commandBus_1.commandBus.register('category.create', new CreateCategoryCommandHandler());
commandBus_1.commandBus.register('category.update', new UpdateCategoryCommandHandler());
commandBus_1.commandBus.register('category.delete', new DeleteCategoryCommandHandler());
commandBus_1.commandBus.register('category.reorder', new ReorderCategoriesCommandHandler());
queryBus_1.queryBus.register('category.list', new ListCategoriesQueryHandler());
queryBus_1.queryBus.register('category.tree', new GetCategoryTreeQueryHandler());
queryBus_1.queryBus.register('category.get', new GetCategoryQueryHandler());
// ── Validation ─────────────────────────────────────────────────
const CreateCategorySchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100),
    code: zod_1.z.string().max(50).optional(),
    description: zod_1.z.string().optional(),
    parentId: zod_1.z.string().uuid().optional(),
    sortOrder: zod_1.z.number().int().optional(),
});
const UpdateCategorySchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100).optional(),
    code: zod_1.z.string().max(50).optional(),
    description: zod_1.z.string().optional(),
    parentId: zod_1.z.string().uuid().nullable().optional(),
    sortOrder: zod_1.z.number().int().optional(),
    isActive: zod_1.z.boolean().optional(),
});
// ── Router ─────────────────────────────────────────────────────
exports.categoryRouter = (0, express_1.Router)({ mergeParams: true });
exports.categoryRouter.use(auth_service_1.authMiddleware);
exports.categoryRouter.use((0, roleGuard_2.requireTenantAccess)());
// GET /v1/tenants/:tenantId/categories
exports.categoryRouter.get('/', async (req, res) => {
    try {
        const tenantId = req.params.tenantId;
        const r = await queryBus_1.queryBus.execute({
            type: 'category.list',
            tenantId: tenantId,
            parentId: req.query.parentId === 'null' ? null : req.query.parentId,
            includeInactive: req.query.includeInactive === 'true',
            withItemCount: req.query.withItemCount === 'true',
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// GET /v1/tenants/:tenantId/categories/tree
exports.categoryRouter.get('/tree', async (req, res) => {
    try {
        const tenantId = req.params.tenantId;
        const r = await queryBus_1.queryBus.execute({ type: 'category.tree', tenantId: tenantId });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// GET /v1/tenants/:tenantId/categories/:id
exports.categoryRouter.get('/:id', async (req, res) => {
    try {
        const tenantId = req.params.tenantId;
        const r = await queryBus_1.queryBus.execute({
            type: 'category.get', categoryId: req.params.id, tenantId: tenantId
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message, 404);
    }
});
// POST /v1/tenants/:tenantId/categories
exports.categoryRouter.post('/', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const body = CreateCategorySchema.parse(req.body);
        const r = await commandBus_1.commandBus.execute({
            type: 'category.create', tenantId: req.params.tenantId, ...body
        });
        ok(res, r, 201);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// PUT /v1/tenants/:tenantId/categories/reorder
exports.categoryRouter.put('/reorder', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const { order } = zod_1.z.object({
            order: zod_1.z.array(zod_1.z.object({ id: zod_1.z.string().uuid(), sortOrder: zod_1.z.number().int() }))
        }).parse(req.body);
        const r = await commandBus_1.commandBus.execute({
            type: 'category.reorder', tenantId: req.params.tenantId, order
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// PUT /v1/tenants/:tenantId/categories/:id
exports.categoryRouter.put('/:id', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const body = UpdateCategorySchema.parse(req.body);
        const r = await commandBus_1.commandBus.execute({
            type: 'category.update', categoryId: req.params.id, tenantId: req.params.tenantId, ...body
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// DELETE /v1/tenants/:tenantId/categories/:id
exports.categoryRouter.delete('/:id', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const r = await commandBus_1.commandBus.execute({
            type: 'category.delete', categoryId: req.params.id, tenantId: req.params.tenantId
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
