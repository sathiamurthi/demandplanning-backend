"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateEntityHandler = void 0;
// handlers/createEntityCommandHandler.ts
const db_1 = require("../../../config/db");
class CreateEntityHandler {
    async execute(command) {
        const { tenantId, entity, payload } = command;
        console.log("i am here at handler");
        switch (entity) {
            case "tenant_industries":
                return await (0, db_1.query)(`INSERT INTO tenant_industries (tenant_id, industry_id)
           VALUES ($1, $2)
           RETURNING *`, [tenantId, payload.industryId]);
            case "store":
                return await (0, db_1.query)(`INSERT INTO store_config (id, tenant_id, name, industry)
           VALUES (gen_random_uuid(), $1, $2, $3)
           RETURNING *`, [tenantId, payload.name, payload.industryId]);
            case "user":
                return await (0, db_1.query)(`INSERT INTO users (id, tenant_id, email, first_name, last_name, role)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'owner')
           RETURNING *`, [tenantId, payload.email, payload.firstName, payload.lastName]);
            default:
                throw new Error(`Unknown entity type: ${entity}`);
        }
    }
}
exports.CreateEntityHandler = CreateEntityHandler;
