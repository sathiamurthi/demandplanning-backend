import { query } from "../../../config/db";

export async function createEntity(entity: string, tenantId: string, payload: any) {
  switch (entity) {
    case "tenant_industries":
      return await query(
        `INSERT INTO tenant_industries (tenant_id, industry_id)
         VALUES ($1, $2)
         RETURNING *`,
        [tenantId, payload.industryId]
      );

    case "store_config":
      return await query(
        `INSERT INTO store_config (id, tenant_id, name, industry)
         VALUES (gen_random_uuid(), $1, $2, $3)
         RETURNING *`,
        [tenantId, payload.name, payload.industryId]
      );

    case "users":
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

export async function getEntities(entity: string, tenantId: string, q: any) {
    let sql: string;
    const params: any[] = [q.tenantId];

    switch (entity) {
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

    const res = await query(sql, params);
    return res;
}
