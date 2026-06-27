// queries/getsalesbystore.handler.ts
import { query } from "../config/db";
import { IQueryHandler } from "../cqrs/queryBus";
import { GetSalesByStoreQuery } from "../dashboard/queries/getsalesbystore";

export class GetSalesByStoreHandler implements IQueryHandler<any> {
  async execute(q: GetSalesByStoreQuery) {
    // Fetch sales with customer details
    const sales = await query<any>(
      `SELECT s.id, s.sale_number, s.sale_date, s.customer_name, s.customer_phone,
              s.customer_email, s.subtotal, s.discount_amount, s.gst_amount, s.total_amount,
              COUNT(si.id) AS item_count
       FROM sales s
       LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE s.store_id = $1
       GROUP BY s.id
       ORDER BY s.sale_date DESC`,
      [q.storeId]
    );

    return sales;
  }
}
