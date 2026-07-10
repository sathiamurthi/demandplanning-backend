"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateSaleCommand = void 0;
class CreateSaleCommand {
    constructor(tenantId, storeId, payload) {
        this.tenantId = tenantId;
        this.storeId = storeId;
        this.payload = payload;
        this.type = "sales.create";
    }
}
exports.CreateSaleCommand = CreateSaleCommand;
