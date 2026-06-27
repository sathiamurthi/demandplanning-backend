import { Router } from "express";
import * as ctrl from "./generic";
import { authMiddleware, tenantContextMiddleware } from "../../auth/auth.service";
import { requestLogger } from "../../middleware/requestlogger";

const EntityRouter = Router();
EntityRouter.use(authMiddleware, tenantContextMiddleware, requestLogger)
EntityRouter.get("/:entity", ctrl.getAll);
EntityRouter.post("/:entity", ctrl.create);
EntityRouter.put("/:entity/:id", ctrl.update);
EntityRouter.delete("/:entity/:id", ctrl.remove);

export default EntityRouter;