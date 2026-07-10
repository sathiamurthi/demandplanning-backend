"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetUserByIdQuery = exports.GetUsersQuery = void 0;
class GetUsersQuery {
    constructor(tenantId, filter, search, storeId, role, isActive) {
        this.tenantId = tenantId;
        this.filter = filter;
        this.search = search;
        this.storeId = storeId;
        this.role = role;
        this.isActive = isActive;
        this.type = "tenant.users.get";
    }
}
exports.GetUsersQuery = GetUsersQuery;
class GetUserByIdQuery {
    constructor(tenantId, userId) {
        this.tenantId = tenantId;
        this.userId = userId;
        this.type = "tenant.users.getById";
    }
}
exports.GetUserByIdQuery = GetUserByIdQuery;
