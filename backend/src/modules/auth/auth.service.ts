import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import jwt, { JwtPayload, Secret, SignOptions } from 'jsonwebtoken';
import { query, queryOne } from '../../config/db';
import { commandBus } from '../../cqrs/commandBus';
import { queryBus } from '../../cqrs/queryBus';
import { AuthPayload, MJwtPayload } from '../../types';
import { successResponse } from '../../utils/response';
import { sendPasswordResetEmail } from '../../utils/email';
import { sendPasswordResetWhatsApp, sendRegistrationWhatsApp } from '../../utils/whatsapp';

// ============================================================
// CONFIG
// ============================================================

const JWT_SECRET: Secret = (process.env.JWT_SECRET || 'dev-secret-change-this') as Secret;
// Parse JWT_EXPIRES_IN like "800m" or "8h" or plain seconds
function parseExpiry(val: string | undefined): number {
  if (!val) return 8 * 3600; // default 8 hours
  if (/^\d+$/.test(val)) return parseInt(val);
  if (val.endsWith('m')) return parseInt(val) * 60;
  if (val.endsWith('h')) return parseInt(val) * 3600;
  if (val.endsWith('d')) return parseInt(val) * 86400;
  return 8 * 3600;
}
const JWT_EXPIRY: number = parseExpiry(process.env.JWT_EXPIRES_IN);

// ============================================================
// RESPONSE HELPERS
// ============================================================

function ok(res: Response, data: any, status = 200) {
  res.status(status).json({
    success: true,
    data,
    timestamp: new Date().toISOString(),
  });
}

function fail(res: Response, message: string, status = 400) {
  res.status(status).json({
    success: false,
    error: message,
    timestamp: new Date().toISOString(),
  });
}

// ============================================================
// JWT HELPERS
// ============================================================


// Use a SignOptions object with explicit typing
const signOptions: SignOptions = {
  expiresIn: JWT_EXPIRY, // ✅ now typed correctly
};

function generateTokens(user: any) {
  const payload: AuthPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    tenantId: user.tenant_id,
    storeId: user.store_id,
    industryId: user.industry_id ?? null,
  };

  const accessToken = jwt.sign(payload, JWT_SECRET, signOptions);
  const refreshToken = uuidv4();

  // Store refresh token in DB
  query(
    `INSERT INTO refresh_tokens (user_id, token, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET token=$2, updated_at=NOW()`,
    [user.id, refreshToken] 
  );

return {
  token_type: "Bearer",
  accessToken,
  refreshToken,
  expiresIn: signOptions.expiresIn,
};

}

function verifyJwt(token: string): AuthPayload {
  return jwt.verify(token, JWT_SECRET) as AuthPayload;
}

// ============================================================
// COMMAND HANDLERS
// ============================================================

class LoginCommandHandler {
  async execute(cmd: any) {
    // Accept email or phone number (10-digit or with country code)
    const identifier = (cmd.email || cmd.phone || '').toLowerCase().trim();
    const isPhone = /^\+?\d{7,15}$/.test(identifier.replace(/\s/g, ''));

    const user = await queryOne<any>(
      `SELECT u.id, u.email, u.phone, u.password_hash, u.tenant_id, u.role,
              u.first_name, u.last_name, u.store_id,
              ic.industry_id
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       LEFT JOIN tenant_industries ti ON ti.tenant_id = t.id
       LEFT JOIN industry_configs ic ON ic.id = ti.industry_id
       WHERE (${isPhone ? 'u.phone=$1' : 'u.email=$1'})
         AND u.is_active = TRUE
       LIMIT 1`,
      [identifier]
    );

    if (!user) throw new Error('Invalid credentials');
    if (user.tenant_id) {
      const tenant = await queryOne<any>(`SELECT is_active FROM tenants WHERE id=$1`, [user.tenant_id]);
      if (tenant && !tenant.is_active) throw new Error('Account is inactive');
    }

    const valid = await bcrypt.compare(cmd.password, user.password_hash || '');
    if (!valid) throw new Error('Invalid credentials');

    const tokens = generateTokens(user);

    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name,
        tenantId: user.tenant_id,
        storeId: user.store_id,
        industryId: user.industry_id,
      },
    };
  }
}

class RegisterCommandHandler {
  async execute(cmd: any) {
    const email = cmd.email ? cmd.email.toLowerCase().trim() : null;
    const phone = cmd.phone ? cmd.phone.trim() : null;

    if (!email && !phone) throw new Error('Email or phone number is required');

    if (email) {
      const existing = await queryOne<any>(`SELECT id FROM users WHERE email=$1`, [email]);
      if (existing) throw new Error('Email already registered');
    }
    if (phone) {
      const existing = await queryOne<any>(`SELECT id FROM users WHERE phone=$1 AND phone<>''`, [phone]);
      if (existing) throw new Error('Phone number already registered');
    }

    const passwordHash = await bcrypt.hash(cmd.password, 10);
    const regType = phone && !email ? 'phone' : 'email';

    const [user] = await query<any>(
      `INSERT INTO users
       (email, phone, password_hash, role, tenant_id, store_id, first_name, last_name, reg_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, email, phone, role, tenant_id, store_id, first_name, last_name, reg_type, created_at`,
      [
        email || `user_${Date.now()}@noemail.local`,
        phone || null,
        passwordHash,
        cmd.role || 'staff',
        cmd.tenantId || null,
        cmd.storeId || null,
        cmd.firstName,
        cmd.lastName,
        regType,
      ]
    );

    if (phone && !email) {
      sendRegistrationWhatsApp(phone, cmd.firstName || '', '').catch((e: Error) =>
        console.warn('[whatsapp] Registration message failed:', e.message)
      );
    }

    return user;
  }
}

class GetMeQueryHandler {
  async execute(q: any) {
    const user = await queryOne<any>(
      `SELECT id, email, role, tenant_id, store_id, first_name, last_name, created_at
       FROM users WHERE id=$1`,
      [q.userId]
    );

    if (!user) throw new Error('User not found');
    return user;
  }
}

// ============================================================
// REGISTER CQRS
// ============================================================

commandBus.register('auth.login', new LoginCommandHandler());
commandBus.register('auth.register', new RegisterCommandHandler());
queryBus.register('auth.me', new GetMeQueryHandler());

// ============================================================
// MIDDLEWARE
// ============================================================

// middleware/tenantContext.ts

export function tenantContextMiddleware(req: Request, res: Response, next: NextFunction) {
  // Prefer tenantId from auth middleware (JWT/session)
  const tenantId = (req as any).user?.tenantId || req.params.tenantId;

  if (!tenantId) {
    return res.status(400).json({ success: false, error: "tenantId required" });
  }

  // Attach to request for downstream handlers
  (req as any).tenantId = tenantId;
  next();
}


export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    return res.status(401).json({ error: "No Authorization header" });
  }

  const parts = authHeader.split(" ");
  const token = parts.length === 2 && parts[0] === "Bearer" ? parts[1] : authHeader;
  console.log("Token received:", token);
  if (!token) {
    return res.status(401).json({ error: "Malformed Authorization header" });
  }

  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET not configured");
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as MJwtPayload;
    if (!decoded || typeof decoded === "string" || !decoded.sub) {
      return res.status(403).json({ error: "Invalid token payload" });
    }
    req.user = {
      sub:        decoded.sub,
      email:      decoded.email,
      tenantId:   decoded.tenantId,
      role:       decoded.role ?? "staff",
      storeId:    decoded.storeId,
      industryId: decoded.industryId,
    };
    next();
  } catch (err: any) {
    if (err?.name === 'TokenExpiredError') {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(403).json({ error: "Invalid token" });
  }
};


// ============================================================
// ROUTES
// ============================================================

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  try {
    const result = await commandBus.execute({
      type: 'auth.login',
      ...req.body,
    });
    ok(res, result);
  } catch (e: any) {
    fail(res, e.message, 401);
  }
});

authRouter.post('/register', async (req, res) => {
  try {
    const result = await commandBus.execute({
      type: 'auth.register',
      ...req.body,
    });
    ok(res, result, 201);
  } catch (e: any) {
    fail(res, e.message);
  }
});

authRouter.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await queryBus.execute({
      type: 'auth.me',
      userId: req.user!.sub,
    });
    ok(res, result);
  } catch (e: any) {
    fail(res, e.message, 404);
  }
});

// POST /v1/auth/forgot-password
authRouter.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return fail(res, 'Email is required', 400);
  try {
    const user = await queryOne<any>(
      `SELECT id, phone FROM users WHERE email=$1 AND is_active=TRUE`,
      [email.toLowerCase().trim()]
    );
    // Always return success to prevent user enumeration
    if (!user) return ok(res, { message: 'If this email exists, a reset link has been sent.' });

    // Generate token
    const token = uuidv4().replace(/-/g, '');
    await query(`DELETE FROM password_resets WHERE user_id=$1`, [user.id]);
    await query(
      `INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 hour')`,
      [user.id, token]
    );

    // Send reset email (falls back to console.log if SMTP not configured)
    await sendPasswordResetEmail(email.toLowerCase().trim(), token);

    if (user.phone) {
      sendPasswordResetWhatsApp(user.phone, token).catch((e: Error) =>
        console.warn('[whatsapp] Password reset message failed:', e.message)
      );
    }

    ok(res, {
      message: 'If this email exists, a reset link has been sent.',
      // Dev helper — remove in production
      ...(process.env.NODE_ENV !== 'production' && { _devToken: token }),
    });
  } catch (e: any) { fail(res, e.message); }
});

// POST /v1/auth/reset-password
authRouter.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return fail(res, 'token and newPassword are required', 400);
  if (newPassword.length < 8) return fail(res, 'Password must be at least 8 characters', 400);
  try {
    const record = await queryOne<any>(
      `SELECT pr.user_id FROM password_resets pr
       WHERE pr.token=$1 AND pr.used=FALSE AND pr.expires_at > NOW()`,
      [token]
    );
    if (!record) return fail(res, 'Invalid or expired reset token', 400);

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await query(`UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2`, [passwordHash, record.user_id]);
    await query(`UPDATE password_resets SET used=TRUE WHERE token=$1`, [token]);

    ok(res, { message: 'Password reset successfully. Please log in with your new password.' });
  } catch (e: any) { fail(res, e.message); }
});

authRouter.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return fail(res, "Missing refresh token", 400);

  try {
    const record = await queryOne<any>(
      `SELECT rt.user_id, u.email, u.role, u.tenant_id, u.store_id, t.industry_id
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE rt.token=$1`,
      [refreshToken]
    );

    if (!record) return fail(res, "Invalid or expired refresh token", 401);

    const payload: AuthPayload = {
      sub: record.user_id,
      email: record.email,
      role: record.role,
      tenantId: record.tenant_id,
      storeId: record.store_id,
      industryId: record.industry_id ?? null,
    };

    const accessToken = jwt.sign(payload, JWT_SECRET, signOptions);

    ok(res, { accessToken, expiresIn: signOptions.expiresIn });
  } catch (e: any) {
    fail(res, e.message, 401);
  }
});

authRouter.get('/temp-db-status', async (req, res) => {
  try {
    const users = await query(
      "SELECT id, phone, email, tenant_id, store_id, first_name, last_name, role, is_active FROM users WHERE phone LIKE '%994354%' OR email LIKE '%dnmsathia%' OR email LIKE '%user_1782578418250%'"
    );

    const tenants = await query(
      "SELECT id, name, slug, industry_id, is_active FROM tenants"
    );

    const stores = await query(
      "SELECT id, tenant_id, name, code, is_active FROM stores"
    );

    res.json({ success: true, users, tenants, stores });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});


