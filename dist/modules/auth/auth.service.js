"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = exports.authMiddleware = void 0;
exports.tenantContextMiddleware = tenantContextMiddleware;
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const uuid_1 = require("uuid");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = require("../../config/db");
const commandBus_1 = require("../../cqrs/commandBus");
const queryBus_1 = require("../../cqrs/queryBus");
const email_1 = require("../../utils/email");
const whatsapp_1 = require("../../utils/whatsapp");
// ============================================================
// CONFIG
// ============================================================
const JWT_SECRET = (process.env.JWT_SECRET || 'dev-secret-change-this');
// Parse JWT_EXPIRES_IN like "800m" or "8h" or plain seconds
function parseExpiry(val) {
    if (!val)
        return 8 * 3600; // default 8 hours
    if (/^\d+$/.test(val))
        return parseInt(val);
    if (val.endsWith('m'))
        return parseInt(val) * 60;
    if (val.endsWith('h'))
        return parseInt(val) * 3600;
    if (val.endsWith('d'))
        return parseInt(val) * 86400;
    return 8 * 3600;
}
const JWT_EXPIRY = parseExpiry(process.env.JWT_EXPIRES_IN);
// ============================================================
// RESPONSE HELPERS
// ============================================================
function ok(res, data, status = 200) {
    res.status(status).json({
        success: true,
        data,
        timestamp: new Date().toISOString(),
    });
}
function fail(res, message, status = 400) {
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
const signOptions = {
    expiresIn: JWT_EXPIRY, // ✅ now typed correctly
};
function generateTokens(user) {
    const payload = {
        sub: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenant_id,
        storeId: user.store_id,
        industryId: user.industry_id ?? null,
    };
    const accessToken = jsonwebtoken_1.default.sign(payload, JWT_SECRET, signOptions);
    const refreshToken = (0, uuid_1.v4)();
    // Store refresh token in DB
    (0, db_1.query)(`INSERT INTO refresh_tokens (user_id, token, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET token=$2, updated_at=NOW()`, [user.id, refreshToken]);
    return {
        token_type: "Bearer",
        accessToken,
        refreshToken,
        expiresIn: signOptions.expiresIn,
    };
}
function verifyJwt(token) {
    return jsonwebtoken_1.default.verify(token, JWT_SECRET);
}
// ============================================================
// COMMAND HANDLERS
// ============================================================
class LoginCommandHandler {
    async execute(cmd) {
        // Accept email or phone number (10-digit or with country code)
        const identifier = (cmd.email || cmd.phone || '').toLowerCase().trim();
        const isPhone = /^\+?\d{7,15}$/.test(identifier.replace(/\s/g, ''));
        const user = await (0, db_1.queryOne)(`SELECT u.id, u.email, u.phone, u.password_hash, u.tenant_id, u.role,
              u.first_name, u.last_name, u.store_id,
              ic.industry_id
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       LEFT JOIN tenant_industries ti ON ti.tenant_id = t.id
       LEFT JOIN industry_configs ic ON ic.id = ti.industry_id
       WHERE (${isPhone ? 'u.phone=$1' : 'u.email=$1'})
         AND u.is_active = TRUE
       LIMIT 1`, [identifier]);
        if (!user)
            throw new Error('Invalid credentials');
        if (user.tenant_id) {
            const tenant = await (0, db_1.queryOne)(`SELECT is_active FROM tenants WHERE id=$1`, [user.tenant_id]);
            if (tenant && !tenant.is_active)
                throw new Error('Account is inactive');
        }
        const valid = await bcryptjs_1.default.compare(cmd.password, user.password_hash || '');
        if (!valid)
            throw new Error('Invalid credentials');
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
    async execute(cmd) {
        const email = cmd.email ? cmd.email.toLowerCase().trim() : null;
        const phone = cmd.phone ? cmd.phone.trim() : null;
        if (!email && !phone)
            throw new Error('Email or phone number is required');
        if (email) {
            const existing = await (0, db_1.queryOne)(`SELECT id FROM users WHERE email=$1`, [email]);
            if (existing)
                throw new Error('Email already registered');
        }
        if (phone) {
            const existing = await (0, db_1.queryOne)(`SELECT id FROM users WHERE phone=$1 AND phone<>''`, [phone]);
            if (existing)
                throw new Error('Phone number already registered');
        }
        const passwordHash = await bcryptjs_1.default.hash(cmd.password, 10);
        const regType = phone && !email ? 'phone' : 'email';
        const [user] = await (0, db_1.query)(`INSERT INTO users
       (email, phone, password_hash, role, tenant_id, store_id, first_name, last_name, reg_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, email, phone, role, tenant_id, store_id, first_name, last_name, reg_type, created_at`, [
            email || `user_${Date.now()}@noemail.local`,
            phone || null,
            passwordHash,
            cmd.role || 'staff',
            cmd.tenantId || null,
            cmd.storeId || null,
            cmd.firstName,
            cmd.lastName,
            regType,
        ]);
        if (phone && !email) {
            (0, whatsapp_1.sendRegistrationWhatsApp)(phone, cmd.firstName || '', '').catch((e) => console.warn('[whatsapp] Registration message failed:', e.message));
        }
        return user;
    }
}
class GetMeQueryHandler {
    async execute(q) {
        const user = await (0, db_1.queryOne)(`SELECT u.id, u.email, u.phone, u.role, u.tenant_id, u.store_id, u.first_name, u.last_name, u.created_at,
              t.name as tenant_name,
              s.name as store_name
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       LEFT JOIN stores s ON s.id = u.store_id
       WHERE u.id=$1`, [q.userId]);
        if (!user)
            throw new Error('User not found');
        return user;
    }
}
// ============================================================
// REGISTER CQRS
// ============================================================
commandBus_1.commandBus.register('auth.login', new LoginCommandHandler());
commandBus_1.commandBus.register('auth.register', new RegisterCommandHandler());
queryBus_1.queryBus.register('auth.me', new GetMeQueryHandler());
// ============================================================
// MIDDLEWARE
// ============================================================
// middleware/tenantContext.ts
function tenantContextMiddleware(req, res, next) {
    // Prefer tenantId from auth middleware (JWT/session)
    const tenantId = req.user?.tenantId || req.params.tenantId;
    if (!tenantId) {
        return res.status(400).json({ success: false, error: "tenantId required" });
    }
    // Attach to request for downstream handlers
    req.tenantId = tenantId;
    next();
}
const authMiddleware = (req, res, next) => {
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
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        if (!decoded || typeof decoded === "string" || !decoded.sub) {
            return res.status(403).json({ error: "Invalid token payload" });
        }
        req.user = {
            sub: decoded.sub,
            email: decoded.email,
            tenantId: decoded.tenantId,
            role: decoded.role ?? "staff",
            storeId: decoded.storeId,
            industryId: decoded.industryId,
        };
        next();
    }
    catch (err) {
        if (err?.name === 'TokenExpiredError') {
            return res.status(401).json({ error: "Token expired" });
        }
        return res.status(403).json({ error: "Invalid token" });
    }
};
exports.authMiddleware = authMiddleware;
// ============================================================
// ROUTES
// ============================================================
exports.authRouter = (0, express_1.Router)();
exports.authRouter.post('/login', async (req, res) => {
    try {
        const result = await commandBus_1.commandBus.execute({
            type: 'auth.login',
            ...req.body,
        });
        ok(res, result);
    }
    catch (e) {
        fail(res, e.message, 401);
    }
});
exports.authRouter.post('/register', async (req, res) => {
    try {
        const result = await commandBus_1.commandBus.execute({
            type: 'auth.register',
            ...req.body,
        });
        ok(res, result, 201);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.authRouter.get('/me', exports.authMiddleware, async (req, res) => {
    try {
        const result = await queryBus_1.queryBus.execute({
            type: 'auth.me',
            userId: req.user.sub,
        });
        ok(res, result);
    }
    catch (e) {
        fail(res, e.message, 404);
    }
});
// POST /v1/auth/forgot-password
exports.authRouter.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email)
        return fail(res, 'Email is required', 400);
    try {
        const user = await (0, db_1.queryOne)(`SELECT id, phone FROM users WHERE email=$1 AND is_active=TRUE`, [email.toLowerCase().trim()]);
        // Always return success to prevent user enumeration
        if (!user)
            return ok(res, { message: 'If this email exists, a reset link has been sent.' });
        // Generate token
        const token = (0, uuid_1.v4)().replace(/-/g, '');
        await (0, db_1.query)(`DELETE FROM password_resets WHERE user_id=$1`, [user.id]);
        await (0, db_1.query)(`INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 hour')`, [user.id, token]);
        // Send reset email (falls back to console.log if SMTP not configured)
        await (0, email_1.sendPasswordResetEmail)(email.toLowerCase().trim(), token);
        if (user.phone) {
            (0, whatsapp_1.sendPasswordResetWhatsApp)(user.phone, token).catch((e) => console.warn('[whatsapp] Password reset message failed:', e.message));
        }
        ok(res, {
            message: 'If this email exists, a reset link has been sent.',
            // Dev helper — remove in production
            ...(process.env.NODE_ENV !== 'production' && { _devToken: token }),
        });
    }
    catch (e) {
        fail(res, e.message);
    }
});
// POST /v1/auth/reset-password
exports.authRouter.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword)
        return fail(res, 'token and newPassword are required', 400);
    if (newPassword.length < 8)
        return fail(res, 'Password must be at least 8 characters', 400);
    try {
        const record = await (0, db_1.queryOne)(`SELECT pr.user_id FROM password_resets pr
       WHERE pr.token=$1 AND pr.used=FALSE AND pr.expires_at > NOW()`, [token]);
        if (!record)
            return fail(res, 'Invalid or expired reset token', 400);
        const passwordHash = await bcryptjs_1.default.hash(newPassword, 10);
        await (0, db_1.query)(`UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2`, [passwordHash, record.user_id]);
        await (0, db_1.query)(`UPDATE password_resets SET used=TRUE WHERE token=$1`, [token]);
        ok(res, { message: 'Password reset successfully. Please log in with your new password.' });
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.authRouter.post("/refresh", async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken)
        return fail(res, "Missing refresh token", 400);
    try {
        const record = await (0, db_1.queryOne)(`SELECT rt.user_id, u.email, u.role, u.tenant_id, u.store_id, t.industry_id
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE rt.token=$1`, [refreshToken]);
        if (!record)
            return fail(res, "Invalid or expired refresh token", 401);
        const payload = {
            sub: record.user_id,
            email: record.email,
            role: record.role,
            tenantId: record.tenant_id,
            storeId: record.store_id,
            industryId: record.industry_id ?? null,
        };
        const accessToken = jsonwebtoken_1.default.sign(payload, JWT_SECRET, signOptions);
        ok(res, { accessToken, expiresIn: signOptions.expiresIn });
    }
    catch (e) {
        fail(res, e.message, 401);
    }
});
