// ============================================================
// TEAFACTORY360 — Agent self-registration (pending owner approval)
// ============================================================
// Public (no auth) — a field agent doesn't have an account yet, so they
// can't look up a tenant by ID. They instead enter their factory's
// "company code" (the tenant's slug, e.g. "abc-tea-agency" from the
// signup URL/slip their factory gives out) and their own details.
// The account is created INACTIVE — an agent role gets real write
// access to growers/collections/dispatch/payments, so anyone who
// guesses a company code must not be able to self-activate. An
// owner/manager approves (or rejects) the request from the Team & Roles
// page, exactly the same "reactivate" action already used there.
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../../config/db';
import { sendWhatsAppText } from '../../utils/whatsapp';

function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}

export const teaAgentAuthRouter = Router();

const RegisterSchema = z.object({
  companyCode: z.string().min(1),
  firstName: z.string().min(1).max(100),
  lastName: z.string().max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(7).max(20).optional(),
  password: z.string().min(6).max(100),
}).refine(d => d.email || d.phone, { message: 'Email or phone is required' });

teaAgentAuthRouter.post('/register', async (req, res) => {
  try {
    const body = RegisterSchema.parse(req.body);
    const slug = body.companyCode.trim().toLowerCase();

    const tenant = await queryOne<any>(
      `SELECT t.id, t.name
       FROM tenants t
       JOIN tenant_industries ti ON ti.tenant_id = t.id
       JOIN industry_configs ic ON ic.id = ti.industry_id
       WHERE t.slug = $1 AND ic.industry_id = 'tea' AND t.is_active = TRUE`,
      [slug]
    );
    if (!tenant) return fail(res, 'Company code not found — check with your factory for the correct code');

    const emailNorm = body.email?.toLowerCase().trim() || null;
    const phoneNorm = body.phone?.trim() || null;

    if (emailNorm) {
      const existing = await queryOne<any>(`SELECT id FROM users WHERE email=$1`, [emailNorm]);
      if (existing) return fail(res, 'Email already registered');
    }
    if (phoneNorm) {
      const existing = await queryOne<any>(`SELECT id FROM users WHERE phone=$1 AND phone<>''`, [phoneNorm]);
      if (existing) return fail(res, 'Phone number already registered');
    }

    const passwordHash = await bcrypt.hash(body.password, 10);
    const [created] = await query<any>(
      `INSERT INTO users (tenant_id, email, phone, password_hash, role, first_name, last_name, is_active, reg_type)
       VALUES ($1,$2,$3,$4,'agent',$5,$6,FALSE,$7)
       RETURNING id, email, phone, first_name, last_name, created_at`,
      [
        tenant.id, emailNorm || `agent_${Date.now()}@noemail.local`, phoneNorm, passwordHash,
        body.firstName, body.lastName || null,
        phoneNorm && !emailNorm ? 'phone' : 'email',
      ]
    );

    // Best-effort — never blocks registration if WhatsApp isn't configured
    // or the owner has no phone on file.
    const owner = await queryOne<any>(
      `SELECT phone FROM users WHERE tenant_id=$1 AND role='owner' AND phone IS NOT NULL AND phone<>'' LIMIT 1`,
      [tenant.id]
    );
    if (owner?.phone) {
      sendWhatsAppText(
        owner.phone,
        `🌿 *TeaFactory360*\n\nA new agent signed up pending your approval:\n*${body.firstName} ${body.lastName || ''}*\n${phoneNorm || emailNorm}\n\nApprove them from Team & Roles in the app.`
      ).catch(() => {});
    }

    ok(res, {
      id: created.id,
      message: `Registration submitted for ${tenant.name}. Your factory owner/manager needs to approve your account before you can sign in.`,
    }, 201);
  } catch (e: any) {
    fail(res, e.message);
  }
});
