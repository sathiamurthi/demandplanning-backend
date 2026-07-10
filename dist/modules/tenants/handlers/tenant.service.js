"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetTenantsQueryHandler = void 0;
exports.getTenantsService = getTenantsService;
const db_1 = require("../../../config/db"); // raw SQL helper
// -----------------------------
// Query Handler
// -----------------------------
class GetTenantsQueryHandler {
    async execute(q) {
        const sql = `
      SELECT id, company_name, admin_email, status, created_at
      FROM tenants
      ORDER BY created_at DESC
    `;
        return (0, db_1.query)(sql);
    }
}
exports.GetTenantsQueryHandler = GetTenantsQueryHandler;
// -----------------------------
// Service Function
// -----------------------------
async function getTenantsService() {
    const handler = new GetTenantsQueryHandler();
    const result = await handler.execute({ type: "admin.tenants.get" });
    return result;
}
