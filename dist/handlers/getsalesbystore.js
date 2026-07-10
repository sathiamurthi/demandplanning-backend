"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetSalesByStoreHandler = void 0;
// queries/getsalesbystore.handler.ts
const db_1 = require("../config/db");
class GetSalesByStoreHandler {
    async execute(q) {
        // Fetch sales with customer details
        const sales = await (0, db_1.query)(`SELECT s.id, s.sale_number, s.sale_date, s.customer_name, s.customer_phone,
              s.customer_email, s.subtotal, s.discount_amount, s.gst_amount, s.total_amount,
              COUNT(si.id) AS item_count
       FROM sales s
       LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE s.store_id = $1
       GROUP BY s.id
       ORDER BY s.sale_date DESC`, [q.storeId]);
        return sales;
    }
}
exports.GetSalesByStoreHandler = GetSalesByStoreHandler;
