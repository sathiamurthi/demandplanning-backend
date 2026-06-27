// handlers/createEntityCommandHandler.ts
import { query } from "../../../config/db";
import { CreateEntityCommand } from "../command.ts/entity";

export class CreateEntityHandler  {
    async execute(command: any) {
    const { tenantId, entity, payload } = command;
    console.log("i am here at handler")
    switch (entity) {
      case "tenant_industries":
        return await query(
          `INSERT INTO tenant_industries (tenant_id, industry_id)
           VALUES ($1, $2)
           RETURNING *`,
          [tenantId, payload.industryId]
        );

      case "store":
        return await query(
          `INSERT INTO store_config (id, tenant_id, name, industry)
           VALUES (gen_random_uuid(), $1, $2, $3)
           RETURNING *`,
          [tenantId, payload.name, payload.industryId]
        );

      case "user":
        return await query(
          `INSERT INTO users (id, tenant_id, email, first_name, last_name, role)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'owner')
           RETURNING *`,
          [tenantId, payload.email, payload.firstName, payload.lastName]
        );

      default:
        throw new Error(`Unknown entity type: ${entity}`);
    }
  }
}
