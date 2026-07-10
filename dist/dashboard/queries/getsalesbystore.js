"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetSalesByStoreQuery = void 0;
// queries/getsalesbystore.query.ts
class GetSalesByStoreQuery {
    constructor(storeId) {
        this.storeId = storeId;
        this.type = "sales.getByStore";
    }
}
exports.GetSalesByStoreQuery = GetSalesByStoreQuery;
