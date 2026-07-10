"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicRouter = void 0;
const queryBus_1 = require("../../cqrs/queryBus");
const commandBus_1 = require("../../cqrs/commandBus");
// assume you have these utilities for DB and bus
const db_1 = require("../../config/db");
const express_1 = require("express");
const apperror_1 = require("../../utils/apperror");
const response_1 = require("../../utils/response");
exports.publicRouter = (0, express_1.Router)();
class GetStoreQueryHandler {
    async execute(q) {
        const store = await (0, db_1.queryOne)("SELECT * FROM store_config");
        if (!store) {
            throw new apperror_1.AppError("Store not found", "STORE_NOT_FOUND", 404);
        }
        return store;
    }
}
function ok(res, data, status = 200) {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res, msg, status = 400) {
    res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}
exports.publicRouter.get("/", async (req, res) => {
    try {
        const user = req.user;
        const result = await queryBus_1.queryBus.execute({
            type: "store.config.list",
        });
        return res.json((0, response_1.successResponse)(result, "Stores fetched successfully", "STORE_LIST_SUCCESS"));
    }
    catch (e) {
        if (e instanceof apperror_1.AppError) {
            return res.status(e.status).json((0, response_1.errorResponse)(e.message, e.code));
        }
        return res
            .status(500)
            .json((0, response_1.errorResponse)("Internal Server Error", "INTERNAL_ERROR"));
    }
});
// class CreateStoreCommandHandler implements ICommandHandler<CreateStoreCommand, any> {
//   async execute(cmd: CreateStoreCommand, user: any) {
//     if (!["admin", "super_admin"].includes(user.role)) {
//       throw new Error("Forbidden: Admins only");
//     }
//     return queryOne<any>(
//       `INSERT INTO stores (tenant_id, industry, name, email, phone, city, state, pincode)
//        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
//        RETURNING *`,
//       [cmd.tenantId, cmd.industry, cmd.name, cmd.email, cmd.phone, cmd.city, cmd.state, cmd.pincode]
//     );
//   }
// }
// export interface UpdateStoreCommand extends ICommand {
//   readonly type: "store.config.update";
//   storeId: string;
//   tenantId: string;
//   name?: string;
//   email?: string;
//   phone?: string;
//   city?: string;
//   state?: string;
//   pincode?: string;
// }
// class UpdateStoreCommandHandler implements ICommandHandler<UpdateStoreCommand, any> {
//   async execute(cmd: UpdateStoreCommand, user: any) {
//     if (!["admin", "super_admin"].includes(user.role)) {
//       throw new Error("Forbidden: Admins only");
//     }
//     return queryOne<any>(
//       `UPDATE stores
//        SET name=COALESCE($3,name),
//            email=COALESCE($4,email),
//            phone=COALESCE($5,phone),
//            city=COALESCE($6,city),
//            state=COALESCE($7,state),
//            pincode=COALESCE($8,pincode),
//            updated_at=NOW()
//        WHERE id=$1 AND tenant_id=$2
//        RETURNING *`,
//       [cmd.storeId, cmd.tenantId, cmd.name, cmd.email, cmd.phone, cmd.city, cmd.state, cmd.pincode]
//     );
//   }
// }
// export interface DeleteStoreCommand extends ICommand {
//   readonly type: "store.config.delete";
//   storeId: string;
//   tenantId: string;
// }
// class DeleteStoreCommandHandler implements ICommandHandler<DeleteStoreCommand, any> {
//   async execute(cmd: DeleteStoreCommand, user: any) {
//     if (!["admin", "super_admin"].includes(user.role)) {
//       throw new Error("Forbidden: Admins only");
//     }
//     await queryOne<any>(
//       `DELETE FROM stores WHERE id=$1 AND tenant_id=$2 RETURNING id`,
//       [cmd.storeId, cmd.tenantId]
//     );
//     return { success: true };
//   }
// }
// --------------------
// Register Handlers
// --------------------
commandBus_1.commandBus.register("store.config.get", new GetStoreQueryHandler());
// commandBus.register("store.config.create", new CreateStoreCommandHandler());
// commandBus.register("store.config.update", new UpdateStoreCommandHandler());
// commandBus.register("store.config.delete", new DeleteStoreCommandHandler());
