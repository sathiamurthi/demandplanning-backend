"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetEntitiesHandler = void 0;
const db_1 = require("../../../config/db");
class GetEntitiesHandler {
    async execute(q) {
        let sql;
        const params = [q.tenantId];
        switch (q.entity) {
            case "store_config":
                // store_config is linked via industry → tenant
                sql = `
            SELECT sc.*
            FROM store_config sc
            JOIN tenant_industries ti ON sc.industry = ti.industry_id
            WHERE ti.tenant_id = $1
            `;
                if (q.search) {
                    sql += ` AND sc.name ILIKE $2`;
                    params.push(`%${q.search}%`);
                }
                break;
            case "orders":
                // example: orders linked via store → tenant
                sql = `
          SELECT o.*
          FROM orders o
          JOIN store s ON o.store_id = s.id
          WHERE s.tenant_id = $1
        `;
                if (q.search) {
                    sql += ` AND o.name ILIKE $2`;
                    params.push(`%${q.search}%`);
                }
                break;
            default:
                // default: entity has tenant_id directly
                sql = `SELECT * FROM ${q.entity} WHERE tenant_id = $1`;
                if (q.search) {
                    sql += ` AND name ILIKE $2`;
                    params.push(`%${q.search}%`);
                }
                break;
        }
        const res = await (0, db_1.query)(sql, params);
        return res;
    }
}
exports.GetEntitiesHandler = GetEntitiesHandler;
