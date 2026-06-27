// routes/registertenant.router.ts
import { Router } from "express";
import { RegisterTenantCommand } from "./registertenant.command";
import { RegisterTenantCommandHandler } from "./registertenant.handler";

const interfaceRouter_Tenant = Router();
const handler = new RegisterTenantCommandHandler();

// POST /v1/ext/tenant/register
interfaceRouter_Tenant.post("/register", async (req, res) => {
  try {
    const { firstName, lastName, industry_id, companyName, email, phone, password } = req.body;

    if (!companyName || !industry_id || !password) {
      return res.status(400).json({ success: false, error: "companyName, industry_id, and password are required" });
    }

    const emailNorm = email ? String(email).toLowerCase().trim() : undefined;
    const phoneNorm = phone ? String(phone).trim() : undefined;

    if (!emailNorm && !phoneNorm) {
      return res.status(400).json({ success: false, error: "Email or phone number is required" });
    }

    const command: RegisterTenantCommand = {
      type: "tenant.register",
      payload: { firstName, lastName, industry_id, companyName, email: emailNorm, phone: phoneNorm, password },
    };

    const tenant = await handler.execute(command);

    res.status(201).json({ success: true, data: tenant });
  } catch (err: any) {
    const status = err.message?.includes('already registered') ? 409 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

export default interfaceRouter_Tenant;
