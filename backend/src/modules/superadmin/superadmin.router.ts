import { Router } from "express";
import * as controller from "./superadmin.controller";

const router = Router();

router.get("/tenants", controller.getTenants);
router.post("/tenants/approve/:id", controller.approveTenant);

router.get("/users", controller.getUsers);
router.patch("/users/:id/password", controller.changePassword);

router.post("/notifications", controller.sendNotification);
router.post("/messages", controller.sendMessage);

router.post("/subscriptions", controller.manageSubscription);

export default router;
