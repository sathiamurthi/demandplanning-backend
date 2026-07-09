// ============================================================
// college360.router.ts — All C360 platform API routes
// Mounted at /v1/c360 in app.ts
// Auth: own JWT scope='c360', same secret as main app
// ============================================================
import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../../config/db';

export const c360Router = Router();

// ── Config ───────────────────────────────────────────────────
const JWT_SECRET: Secret = (process.env.JWT_SECRET || 'dev-secret-change-this') as Secret;
const signOptions: SignOptions = { expiresIn: 8 * 3600 };

// ── Helpers ──────────────────────────────────────────────────
function ok(res: Response, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: Response, message: string, status = 400) {
  res.status(status).json({ success: false, error: message, timestamp: new Date().toISOString() });
}
function makeToken(user: any) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, scope: 'c360' },
    JWT_SECRET,
    signOptions
  );
}

// ── Auth middleware ───────────────────────────────────────────
interface C360Req extends Request { c360User?: any; }

function c360Auth(req: C360Req, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
  try {
    const decoded: any = jwt.verify(header.slice(7), JWT_SECRET);
    if (decoded.scope !== 'c360') { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
    req.c360User = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Token expired or invalid' });
  }
}

// ── REGISTER ─────────────────────────────────────────────────
c360Router.post('/auth/register', async (req, res) => {
  try {
    const { name, email, phone, password, role = 'student', college, branch, year, gradYear } = req.body;
    if (!name || !email || !password) { fail(res, 'name, email and password are required'); return; }
    const emailLc = email.toLowerCase().trim();
    const existing = await queryOne<any>('SELECT id FROM c360_users WHERE email=$1', [emailLc]);
    if (existing) { fail(res, 'Email already registered'); return; }
    const hash = await bcrypt.hash(password, 10);
    const [user] = await query<any>(
      `INSERT INTO c360_users (name, email, phone, password_hash, role, college, branch, year, grad_year)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, name, email, phone, role, college, branch, year, grad_year, premium, created_at`,
      [name, emailLc, phone || null, hash, role, college || null, branch || null, year || null, gradYear || null]
    );
    const token = makeToken(user);
    ok(res, { token, user }, 201);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── LOGIN ─────────────────────────────────────────────────────
c360Router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) { fail(res, 'email and password are required'); return; }
    const user = await queryOne<any>(
      `SELECT id, name, email, phone, password_hash, role, college, branch, year, grad_year, premium
       FROM c360_users WHERE email=$1 AND is_active=TRUE`,
      [email.toLowerCase().trim()]
    );
    if (!user) { fail(res, 'Invalid email or password', 401); return; }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) { fail(res, 'Invalid email or password', 401); return; }
    const { password_hash: _, ...safeUser } = user;
    const token = makeToken(safeUser);
    ok(res, { token, user: safeUser });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── RESET PASSWORD ────────────────────────────────────────────
c360Router.post('/auth/reset-password', async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    if (!email || !newPassword) { fail(res, 'email and newPassword required'); return; }
    if (newPassword.length < 6) { fail(res, 'Password must be at least 6 characters'); return; }
    const user = await queryOne<any>('SELECT id FROM c360_users WHERE email=$1', [email.toLowerCase().trim()]);
    if (!user) { fail(res, 'No account found with that email', 404); return; }
    const hash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE c360_users SET password_hash=$1 WHERE id=$2', [hash, user.id]);
    ok(res, { message: 'Password updated successfully' });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── ME ────────────────────────────────────────────────────────
c360Router.get('/auth/me', c360Auth, async (req: C360Req, res) => {
  try {
    const user = await queryOne<any>(
      `SELECT id, name, email, phone, role, college, branch, year, grad_year, linkedin, github, premium, created_at
       FROM c360_users WHERE id=$1 AND is_active=TRUE`,
      [req.c360User.sub]
    );
    if (!user) { fail(res, 'User not found', 404); return; }
    ok(res, user);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── UPDATE PROFILE (basic user fields) ───────────────────────
c360Router.put('/auth/me', c360Auth, async (req: C360Req, res) => {
  try {
    const { name, phone, college, branch, year, gradYear, linkedin, github } = req.body;
    const [user] = await query<any>(
      `UPDATE c360_users
       SET name=COALESCE($1,name), phone=COALESCE($2,phone), college=COALESCE($3,college),
           branch=COALESCE($4,branch), year=COALESCE($5,year), grad_year=COALESCE($6,grad_year),
           linkedin=COALESCE($7,linkedin), github=COALESCE($8,github)
       WHERE id=$9
       RETURNING id, name, email, phone, role, college, branch, year, grad_year, linkedin, github, premium`,
      [name||null, phone||null, college||null, branch||null, year||null, gradYear||null, linkedin||null, github||null, req.c360User.sub]
    );
    ok(res, user);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── PROFILE (detailed career profile) ────────────────────────
c360Router.get('/profile', c360Auth, async (req: C360Req, res) => {
  try {
    const profile = await queryOne<any>('SELECT * FROM c360_profiles WHERE user_id=$1', [req.c360User.sub]);
    ok(res, profile || null);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

c360Router.put('/profile', c360Auth, async (req: C360Req, res) => {
  try {
    const { skills, tools, softSkills, targetRole, jobType, objective, degree, cgpa, courses, achievements, projects, certifications } = req.body;
    const [profile] = await query<any>(
      `INSERT INTO c360_profiles
         (user_id, skills, tools, soft_skills, target_role, job_type, objective, degree, cgpa, courses, achievements, projects, certifications, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         skills=EXCLUDED.skills, tools=EXCLUDED.tools, soft_skills=EXCLUDED.soft_skills,
         target_role=EXCLUDED.target_role, job_type=EXCLUDED.job_type, objective=EXCLUDED.objective,
         degree=EXCLUDED.degree, cgpa=EXCLUDED.cgpa, courses=EXCLUDED.courses,
         achievements=EXCLUDED.achievements, projects=EXCLUDED.projects,
         certifications=EXCLUDED.certifications, updated_at=NOW()
       RETURNING *`,
      [
        req.c360User.sub,
        skills || [], tools || [], softSkills || [],
        targetRole || null, jobType || null, objective || null,
        degree || null, cgpa || null, courses || null, achievements || null,
        JSON.stringify(projects || []), JSON.stringify(certifications || []),
      ]
    );
    ok(res, profile);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── MESSAGES ─────────────────────────────────────────────────
c360Router.get('/messages', c360Auth, async (req: C360Req, res) => {
  try {
    const msgs = await query<any>(
      `SELECT * FROM c360_messages WHERE from_id=$1 OR to_id=$1 ORDER BY created_at ASC`,
      [req.c360User.sub]
    );
    ok(res, msgs);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

c360Router.post('/messages', c360Auth, async (req: C360Req, res) => {
  try {
    const { toId, toName, content } = req.body;
    if (!toId || !content) { fail(res, 'toId and content required'); return; }
    const sender = await queryOne<any>('SELECT name FROM c360_users WHERE id=$1', [req.c360User.sub]);
    const [msg] = await query<any>(
      `INSERT INTO c360_messages (from_id, to_id, from_name, to_name, content)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.c360User.sub, toId, sender?.name || '', toName || '', content]
    );
    ok(res, msg, 201);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

c360Router.put('/messages/read', c360Auth, async (req: C360Req, res) => {
  try {
    const { partnerId } = req.body;
    await query(
      `UPDATE c360_messages SET read=TRUE WHERE to_id=$1 AND from_id=$2 AND read=FALSE`,
      [req.c360User.sub, partnerId]
    );
    ok(res, { updated: true });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── PAYMENTS ─────────────────────────────────────────────────
c360Router.get('/payments', c360Auth, async (req: C360Req, res) => {
  try {
    const type = req.query.type as string | undefined;
    const rows = await query<any>(
      `SELECT * FROM c360_payments WHERE user_id=$1 ${type ? 'AND type=$2' : ''} ORDER BY created_at DESC`,
      type ? [req.c360User.sub, type] : [req.c360User.sub]
    );
    ok(res, rows);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

c360Router.post('/payments', c360Auth, async (req: C360Req, res) => {
  try {
    const { txnId, amount, type = 'premium', note } = req.body;
    if (!txnId || !amount) { fail(res, 'txnId and amount required'); return; }
    const user = await queryOne<any>('SELECT name, email FROM c360_users WHERE id=$1', [req.c360User.sub]);
    const [payment] = await query<any>(
      `INSERT INTO c360_payments (user_id, user_name, user_email, txn_id, amount, type, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.c360User.sub, user?.name || '', user?.email || '', txnId, amount, type, note || null]
    );
    ok(res, payment, 201);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── APPLICATIONS ─────────────────────────────────────────────
c360Router.get('/applications', c360Auth, async (req: C360Req, res) => {
  try {
    const rows = await query<any>(
      'SELECT * FROM c360_applications WHERE user_id=$1 ORDER BY applied_at DESC',
      [req.c360User.sub]
    );
    ok(res, rows);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

c360Router.post('/applications', c360Auth, async (req: C360Req, res) => {
  try {
    const { oppId, oppTitle, company } = req.body;
    const [app] = await query<any>(
      `INSERT INTO c360_applications (user_id, opp_id, opp_title, company)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.c360User.sub, oppId || null, oppTitle || null, company || null]
    );
    ok(res, app, 201);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── UPGRADE PREMIUM (admin-triggered via payment approval) ────
c360Router.post('/payments/:paymentId/approve', async (req, res) => {
  // Basic internal key guard — replace with superadmin auth if needed
  if (req.headers['x-admin-key'] !== (process.env.ADMIN_SECRET || 'c360-admin')) {
    res.status(403).json({ success: false, error: 'Forbidden' }); return;
  }
  try {
    const [payment] = await query<any>(
      `UPDATE c360_payments SET status='approved' WHERE id=$1 RETURNING user_id, type`,
      [req.params.paymentId]
    );
    if (!payment) { fail(res, 'Payment not found', 404); return; }
    if (payment.type === 'premium') {
      await query('UPDATE c360_users SET premium=TRUE WHERE id=$1', [payment.user_id]);
    }
    ok(res, { approved: true, type: payment.type });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

c360Router.post('/payments/:paymentId/reject', async (req, res) => {
  if (req.headers['x-admin-key'] !== (process.env.ADMIN_SECRET || 'c360-admin')) {
    res.status(403).json({ success: false, error: 'Forbidden' }); return;
  }
  try {
    await query(`UPDATE c360_payments SET status='rejected' WHERE id=$1`, [req.params.paymentId]);
    ok(res, { rejected: true });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── SUPERADMIN: list all payments ────────────────────────────
c360Router.get('/admin/payments', async (req, res) => {
  if (req.headers['x-admin-key'] !== (process.env.ADMIN_SECRET || 'c360-admin')) {
    res.status(403).json({ success: false, error: 'Forbidden' }); return;
  }
  try {
    const rows = await query<any>(
      `SELECT p.*, u.name as user_name, u.email as user_email, u.college
       FROM c360_payments p JOIN c360_users u ON u.id=p.user_id
       ORDER BY p.created_at DESC`,
      []
    );
    ok(res, rows);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── SUPERADMIN: list all users ────────────────────────────────
c360Router.get('/admin/users', async (req, res) => {
  if (req.headers['x-admin-key'] !== (process.env.ADMIN_SECRET || 'c360-admin')) {
    res.status(403).json({ success: false, error: 'Forbidden' }); return;
  }
  try {
    const rows = await query<any>(
      `SELECT id, name, email, phone, role, college, branch, year, premium, created_at
       FROM c360_users ORDER BY created_at DESC`,
      []
    );
    ok(res, rows);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});
