"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// routes/registertenant.router.ts
const express_1 = require("express");
const registertenant_handler_1 = require("./registertenant.handler");
const interfaceRouter_Tenant = (0, express_1.Router)();
const handler = new registertenant_handler_1.RegisterTenantCommandHandler();
// POST /v1/ext/tenant/register
interfaceRouter_Tenant.post("/register", async (req, res) => {
    try {
        const { firstName, lastName, industry_id, companyName, email, phone, password, source } = req.body;
        if (!companyName || !industry_id || !password) {
            return res.status(400).json({ success: false, error: "companyName, industry_id, and password are required" });
        }
        const emailNorm = email ? String(email).toLowerCase().trim() : undefined;
        const phoneNorm = phone ? String(phone).trim() : undefined;
        if (!emailNorm && !phoneNorm) {
            return res.status(400).json({ success: false, error: "Email or phone number is required" });
        }
        const command = {
            type: "tenant.register",
            payload: { firstName, lastName, industry_id, companyName, email: emailNorm, phone: phoneNorm, password, source },
        };
        const tenant = await handler.execute(command);
        res.status(201).json({ success: true, data: tenant });
    }
    catch (err) {
        const status = err.message?.includes('already registered') ? 409 : 500;
        res.status(status).json({ success: false, error: err.message });
    }
});
exports.default = interfaceRouter_Tenant;
