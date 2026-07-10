"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_service_1 = require("../../auth/auth.service");
const user_service_1 = require("./../services/user.service");
const response_1 = require("../../../utils/response");
const apperror_1 = require("../../../utils/apperror");
const requestlogger_1 = require("../../middleware/requestlogger");
const usersRouter = (0, express_1.Router)({ mergeParams: true });
usersRouter.use(auth_service_1.authMiddleware, auth_service_1.tenantContextMiddleware, requestlogger_1.requestLogger);
usersRouter.get("/", async (req, res) => {
    try {
        const { filter, search, storeId, role, isActive } = req.query;
        const tenantId = req.user.tenantId;
        const users = await (0, user_service_1.getUsersService)(tenantId, filter, search, storeId, role, isActive);
        return res.json((0, response_1.apiResponse)(users));
    }
    catch (err) {
        if (err instanceof apperror_1.AppError) {
            return res.status(err.status).json((0, response_1.errorResponse)(err.message, err.code));
        }
        return res.status(500).json((0, response_1.errorResponse)("Internal Server Error", "INTERNAL_ERROR"));
    }
});
// -----------------------------
// GET single user by ID
// -----------------------------
usersRouter.get("/:userId", async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = await (0, user_service_1.getUserByIdService)(tenantId, req.params.userId);
        res.json({ success: true, data });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// -----------------------------
// CREATE new user
// -----------------------------
usersRouter.post("/", async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = await (0, user_service_1.createUserService)(tenantId, req.body);
        res.json({ success: true, data });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// -----------------------------
// UPDATE existing user
// -----------------------------
usersRouter.put("/:userId", async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = await (0, user_service_1.updateUserService)(tenantId, req.params.userId, req.body);
        res.json({ success: true, data });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// -----------------------------
// DELETE user
// -----------------------------
usersRouter.delete("/:userId", async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        await (0, user_service_1.deleteUserService)(tenantId, req.params.userId);
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// -----------------------------
// CHANGE password
// -----------------------------
usersRouter.post("/:userId/change-password", async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        await (0, user_service_1.changePasswordService)(tenantId, req.params.userId, req.body.newPassword);
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
exports.default = usersRouter;
