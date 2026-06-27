import { Router } from "express";
import { authMiddleware , tenantContextMiddleware} from "../../auth/auth.service";
import { changePasswordService, createUserService, deleteUserService, getUserByIdService, getUsersService, updateUserService } from "./../services/user.service";
import { apiResponse, errorResponse, successResponse } from "../../../utils/response";
import { AppError } from "../../../utils/apperror";
import { requestLogger } from "../../middleware/requestlogger";
import {ApiResponse} from "../../../types"

const usersRouter = Router({ mergeParams: true });
usersRouter.use(authMiddleware, tenantContextMiddleware, requestLogger   );

usersRouter.get("/", async (req, res) => {
  try {
    const { filter, search, storeId, role, isActive } = req.query;
    const tenantId = (req as any).user.tenantId;
    const users = await getUsersService(
      tenantId,
      filter as string,
      search as string,
      storeId as string,
      role as string,
      isActive as string,
    );
    return res.json(apiResponse(users));
  } catch (err: any) {
    if (err instanceof AppError) {
      return res.status(err.status).json(errorResponse(err.message, err.code));
    }
    return res.status(500).json(errorResponse("Internal Server Error", "INTERNAL_ERROR"));
  }
});

// -----------------------------
// GET single user by ID
// -----------------------------
usersRouter.get("/:userId", async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const data = await getUserByIdService(tenantId, req.params.userId);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------
// CREATE new user
// -----------------------------
usersRouter.post("/", async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const data = await createUserService(tenantId, req.body);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------
// UPDATE existing user
// -----------------------------
usersRouter.put("/:userId", async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const data = await updateUserService(tenantId, req.params.userId, req.body);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------
// DELETE user
// -----------------------------
usersRouter.delete("/:userId", async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    await deleteUserService(tenantId, req.params.userId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------
// CHANGE password
// -----------------------------
usersRouter.post("/:userId/change-password", async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    await changePasswordService(tenantId, req.params.userId, req.body.newPassword);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});


export default usersRouter;
