
import { queryBus, IQuery, IQueryHandler } from '../../cqrs/queryBus';
import { commandBus, ICommand, ICommandHandler } from '../../cqrs/commandBus';

// assume you have these utilities for DB and bus
import { query, queryOne, withTransaction } from '../../config/db';
import { Router } from 'express';
import { AppError } from '../../utils/apperror';
import { errorResponse, successResponse } from '../../utils/response';

// --------------------
// QUERY: Get Store
// --------------------
export interface GetStoreQuery extends IQuery {
  readonly type: "store.config.get";
}

export const publicRouter = Router();


class GetStoreQueryHandler implements IQueryHandler<GetStoreQuery, any> {
  async execute(q: GetStoreQuery) {
    const store = await queryOne<any>(
      "SELECT * FROM store_config"
    );

    if (!store) {
      throw new AppError("Store not found", "STORE_NOT_FOUND", 404);
    }

    return store;
  }
}
// --------------------
// COMMANDS: Create / Update / Delete
// --------------------
export interface CreateStoreCommand extends ICommand {
  readonly type: "store.config.create";
  tenantId: string;
  name: string;
  industry: string;
  email?: string;
  phone?: string;
  city?: string;
  state?: string;
  pincode?: string;
}


function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}

publicRouter.get("/", async (req, res) => {
  try {
    const user = (req as any).user;

    const result = await queryBus.execute({
      type: "store.config.list",
    });

    return res.json(
      successResponse(result, "Stores fetched successfully", "STORE_LIST_SUCCESS")
    );

  } catch (e: any) {
    if (e instanceof AppError) {
      return res.status(e.status).json(errorResponse(e.message, e.code));
    }

    return res
      .status(500)
      .json(errorResponse("Internal Server Error", "INTERNAL_ERROR"));
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
commandBus.register("store.config.get", new GetStoreQueryHandler());
// commandBus.register("store.config.create", new CreateStoreCommandHandler());
// commandBus.register("store.config.update", new UpdateStoreCommandHandler());
// commandBus.register("store.config.delete", new DeleteStoreCommandHandler());
