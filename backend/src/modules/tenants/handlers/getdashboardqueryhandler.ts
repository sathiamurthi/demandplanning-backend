import { IQuery, IQueryHandler , queryBus } from "../../../cqrs/queryBus";
import { query } from "../../../config/db"; // raw SQL helper
import { DashboardData } from "../../../types";

// -----------------------------
// Query Definition
// -----------------------------
export interface GetDashboardQuery extends IQuery {
  readonly type: "tenant.dashboard.get";
  tenantId: string;
}

// -----------------------------
// Query Handler
// -----------------------------
export class GetDashboardQueryHandler implements IQueryHandler<GetDashboardQuery, DashboardData> {
  async execute(q: GetDashboardQuery): Promise<DashboardData> {
    const tenantId = q.tenantId;

    // Summary metrics
    const summaryRows = await query(
      `SELECT 
        COUNT(*) AS "totalItems",
        SUM(CASE WHEN current_stock < reorder_level THEN 1 ELSE 0 END) AS "lowStock",
        SUM(CASE WHEN current_stock = 0 THEN 1 ELSE 0 END) AS "outOfStock",
        SUM(CASE WHEN current_stock > max_stock_level THEN 1 ELSE 0 END) AS "overStock"
      FROM items
      WHERE tenant_id = $1;`,
      [tenantId]
    );
    const summary = summaryRows[0];

    // Recent sales (join sales + sale_items + items)
    const recentSales = await query(
      `SELECT *
FROM (
  SELECT 
    si.sale_id,
    i.id AS "itemId",
    i.name AS "item",
    SUM(si.qty_sold)::int AS "quantity",
    MAX(s.sale_date) AS "lastSaleDate"
  FROM sale_items si
  JOIN items i ON si.item_id = i.id
  JOIN sales s ON si.sale_id = s.id
  WHERE i.tenant_id = $1
  GROUP BY si.sale_id, i.id, i.name
) t
ORDER BY t."lastSaleDate" DESC
LIMIT 10;
;
`,
      [tenantId]
    );

    // Script-based Alerts
    const alerts = await query(
      `SELECT id,
              CASE 
                WHEN current_stock = 0 THEN 'Out of stock: ' || name
                WHEN current_stock < reorder_level THEN 'Low stock: ' || name
                WHEN current_stock > max_stock_level THEN 'Overstock: ' || name
              END AS message
       FROM items
       WHERE tenant_id = $1
         AND (current_stock = 0 OR current_stock < reorder_level OR current_stock > max_stock_level)
       LIMIT 10`,
      [tenantId]
    );

    // Script-based Forecasts
    const forecasts = await query(
      `SELECT name AS item,
              (monthly_usage_avg * 1.2) AS predicted,
              80 AS confidence,
              GREATEST(reorder_level - current_stock, 0) AS "orderQty",
              'Plain forecast based on usage average' AS note
       FROM items
       WHERE tenant_id = $1
       LIMIT 10`,
      [tenantId]
    );

    return { summary, recentSales, alerts, forecasts };
  }
}



// -----------------------------
// Service Function
// -----------------------------
export async function getDashboardService(tenantId: string) {
  const handler = new GetDashboardQueryHandler();
  return handler.execute({ type: "tenant.dashboard.get", tenantId });
}
