import { query } from "../../config/db";
import { GetDashboardQuery } from "./getdashboard.query";
import { DashboardDto } from "../dto/dashboard.dto";

export class GetDashboardHandler {
  async execute(q: GetDashboardQuery): Promise<DashboardDto> {
    const { storeId } = q;

    const [totalItemsRow] = await query<any>(
      `SELECT COUNT(*)::int AS count FROM items WHERE store_id=$1`,
      [storeId]
    );

    const [stockValueRow] = await query<any>(
      `SELECT COALESCE(SUM(current_stock * selling_price),0)::numeric AS total
       FROM items WHERE store_id=$1`,
      [storeId]
    );

    const [lowStockRow] = await query<any>(
      `SELECT COUNT(*)::int AS count
       FROM items WHERE store_id=$1 AND current_stock <= reorder_level AND reorder_level > 0`,
      [storeId]
    );

    const [outOfStockRow] = await query<any>(
      `SELECT COUNT(*)::int AS count FROM items WHERE store_id=$1 AND current_stock = 0`,
      [storeId]
    );

    const [todaySalesRow] = await query<any>(
      `SELECT COALESCE(SUM(total_amount),0)::numeric AS total
       FROM sales WHERE store_id=$1 AND sale_date::date = CURRENT_DATE`,
      [storeId]
    );

    const [monthSalesRow] = await query<any>(
      `SELECT COALESCE(SUM(total_amount),0)::numeric AS total
       FROM sales WHERE store_id=$1 AND DATE_TRUNC('month', sale_date) = DATE_TRUNC('month', NOW())`,
      [storeId]
    );

    const salesTrend = await query<any>(
      `SELECT DATE(sale_date) AS day, SUM(total_amount)::numeric AS total
       FROM sales WHERE store_id=$1 AND sale_date >= NOW() - INTERVAL '30 days'
       GROUP BY day ORDER BY day`,
      [storeId]
    );

    const lowStockItems = await query<any>(
      `SELECT name, current_stock, reorder_level,
              ROUND(((reorder_level - current_stock)::numeric / GREATEST(reorder_level,1)) * 100) AS deficit_pct
       FROM items
       WHERE store_id=$1 AND current_stock <= reorder_level AND reorder_level > 0
       ORDER BY current_stock ASC
       LIMIT 10`,
      [storeId]
    );

    const alerts = await query<any>(
      `SELECT message, severity, created_at
       FROM ai_alerts
       WHERE store_id=$1 AND is_read=false
       ORDER BY created_at DESC
       LIMIT 10`,
      [storeId]
    );

    const forecast = await query<any>(
      `SELECT DISTINCT ON (f.item_id) i.name, f.predicted_qty_30d, f.risk_level,
              f.confidence_pct, f.order_needed, f.reasoning
       FROM ai_forecasts f
       JOIN items i ON i.id=f.item_id
       WHERE f.store_id=$1
       ORDER BY f.item_id, f.created_at DESC
       LIMIT 10`,
      [storeId]
    );

    const topItems = await query<any>(
      `SELECT i.name, SUM(si.qty_sold)::int AS qty_sold,
              SUM(si.qty_sold * si.unit_price)::numeric AS revenue
       FROM sale_items si
       JOIN items i ON i.id = si.item_id
       JOIN sales s ON s.id = si.sale_id
       WHERE s.store_id=$1 AND s.sale_date >= NOW() - INTERVAL '30 days'
       GROUP BY i.name ORDER BY revenue DESC LIMIT 5`,
      [storeId]
    );

    return {
      totalItems:   totalItemsRow?.count ?? 0,
      stockValue:   Number(stockValueRow?.total ?? 0),
      lowStock:     lowStockRow?.count ?? 0,
      outOfStock:   outOfStockRow?.count ?? 0,
      todaySales:   Number(todaySalesRow?.total ?? 0),
      monthSales:   Number(monthSalesRow?.total ?? 0),
      salesTrend,
      lowStockItems,
      alerts,
      forecast,
      topItems,
    } as any;
  }
}
