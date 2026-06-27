// commands/createSaleCommand.ts
import { ICommand } from "./../cqrs/commandBus";

export class CreateSaleCommand  {
  public readonly type = "sales.create";
  constructor(
    public readonly tenantId: string,
    public readonly storeId: string,
    public readonly payload: {
      sale_number: string;
      sale_type: string;
      sale_date: string;
      customer_name: string;
      customer_phone: string;
      customer_email: string;
      payment_method: string;
      notes?: string;
      items: {
        item_id: string;
        qty_sold: number;
        unit_id: string;
        unit_price: number;
        discount_pct: number;
        gst_rate: number;
      }[];
    }
  ) {}
}
