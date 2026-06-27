// queries/getsalesbystore.query.ts
export class GetSalesByStoreQuery {
 public readonly type = "sales.getByStore";
  constructor(public readonly storeId: string) {}
}
