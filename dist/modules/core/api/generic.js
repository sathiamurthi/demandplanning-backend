"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAll = getAll;
exports.update = update;
exports.remove = remove;
exports.create = create;
const generic_1 = require("../services/generic");
const entityservice_1 = require("./entityservice");
/* ================= HELPERS ================= */
function getString(value) {
    if (Array.isArray(value))
        return value[0];
    return value;
}
/* ================= GET ALL ================= */
async function getAll(req, res) {
    try {
        const entity = req.params.entity; // must match case labels
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            return res.status(400).json({ success: false, error: "tenantId required" });
        }
        const result = await (0, entityservice_1.getEntities)(entity, tenantId, req.body);
        res.json({ success: true, data: result });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
async function update(req, res) {
    const entity = getString(req.params.entity);
    const id = getString(req.params.id);
    const tenantId = req.user.tenantId;
    const result = await (0, generic_1.updateEntity)(entity, tenantId, // ✅ keep tenant scope
    req.body);
    res.json({ success: true, data: result });
}
async function remove(req, res) {
    const entity = getString(req.params.entity);
    const id = getString(req.params.id);
    const tenantId = req.user.tenantId;
    await (0, generic_1.deleteEntity)(entity, tenantId, // ✅ important for multi-tenant safety
    id);
    res.json({ success: true });
}
async function create(req, res) {
    try {
        const entity = req.params.entity; // must match case labels
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            return res.status(400).json({ success: false, error: "tenantId required" });
        }
        const result = await (0, entityservice_1.createEntity)(entity, tenantId, req.body);
        res.json({ success: true, data: result });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
