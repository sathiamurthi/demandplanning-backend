import { queryBus, IQuery , IQueryHandler} from "../../../cqrs/queryBus";
import { query } from "../../../config/db"; // raw SQL helper
import { GetDashboardQueryHandler } from "./getdashboardqueryhandler";

export interface GetTenantsQuery extends IQuery {
  readonly type: "admin.tenants.get";
}

// -----------------------------
// Query Handler
// -----------------------------
export class GetTenantsQueryHandler implements IQueryHandler<GetTenantsQuery, any> {
  async execute(q: GetTenantsQuery) {
    const sql = `
      SELECT id, company_name, admin_email, status, created_at
      FROM tenants
      ORDER BY created_at DESC
    `;
    return query(sql);
  }
}

// -----------------------------
// Service Function
// -----------------------------
export async function getTenantsService() {
  const handler = new GetTenantsQueryHandler();
  const result = await handler.execute({ type: "admin.tenants.get" });
  return result;
}
