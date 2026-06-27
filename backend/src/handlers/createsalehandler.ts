// handlers/createSaleHandler.ts
import { CreateSaleCommand } from "../commands/createsalecommand";
import { pool } from "../config/db"; // pg Pool
import { ICommandHandler } from "../cqrs/commandBus";

export class CreateSaleHandler implements ICommandHandler<CreateSaleCommand> {
  async execute(command: CreateSaleCommand) {
    const { tenantId, storeId, payload } = command;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Insert sale header
      const saleResult = await client.query(
        `INSERT INTO sales (
          store_id, tenant_id, sale_number, sale_type, sale_date,
          customer_name, customer_phone, customer_email,
          subtotal, discount_amount, gst_amount, total_amount,
          payment_method, notes, created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
        RETURNING id`,
        [
          storeId,
          tenantId,
          payload.sale_number,
          payload.sale_type,
          payload.sale_date,
          payload.customer_name,
          payload.customer_phone,
          payload.customer_email,
          0, 0, 0, 0, // initial totals
          payload.payment_method,
          payload.notes || null,
        ]
      );

      const saleId = saleResult.rows[0].id;

      let subtotal = 0, discount = 0, gst = 0, total = 0;

      // Insert line items
      for (const item of payload.items) {
        const lineSubtotal = item.qty_sold * item.unit_price;
        const lineDiscount = (lineSubtotal * item.discount_pct) / 100;
        const lineAfterDiscount = lineSubtotal - lineDiscount;
        const lineGst = (lineAfterDiscount * item.gst_rate) / 100;
        const lineTotal = lineAfterDiscount + lineGst;

        subtotal += lineSubtotal;
        discount += lineDiscount;
        gst += lineGst;
        total += lineTotal;

        await client.query(
          `INSERT INTO sale_items (
            sale_id, item_id, qty_sold, unit_id, unit_price,
            discount_pct, discount_amount, gst_rate, gst_amount, line_total, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
          [
            saleId,
            item.item_id,
            item.qty_sold,
            item.unit_id,
            item.unit_price,
            item.discount_pct,
            lineDiscount,
            item.gst_rate,
            lineGst,
            lineTotal,
          ]
        );
      }

      // Update sale totals
      await client.query(
        `UPDATE sales
         SET subtotal=$2, discount_amount=$3, gst_amount=$4, total_amount=$5
         WHERE id=$1`,
        [saleId, subtotal, discount, gst, total]
      );

      await client.query("COMMIT");

      return { id: saleId, subtotal, discount, gst, total };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
