// ============================================================
// college360.router.ts — All C360 platform API routes
// Mounted at /v1/c360 in app.ts
// Auth: own JWT scope='c360', same secret as main app
// ============================================================
import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import { query, queryOne, runMigrations } from '../../config/db';

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

// ── STATUS (diagnostic) ───────────────────────────────────────
c360Router.get('/status', async (_req, res) => {
  try {
    const tables = await query<any>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'c360%' ORDER BY tablename`,
      []
    );
    const migrations = await query<any>(`SELECT name, run_at FROM _migrations WHERE name LIKE '%college360%' OR name LIKE '%c360%' ORDER BY name`, []);
    ok(res, { tables: tables.map((t: any) => t.tablename), migrations });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ── RUN MIGRATIONS (admin debug) ─────────────────────────────
c360Router.post('/admin/run-migrations', async (req, res) => {
  if (req.headers['x-admin-key'] !== (process.env.ADMIN_SECRET || 'c360-admin')) {
    res.status(403).json({ success: false, error: 'Forbidden' }); return;
  }
  try {
    await runMigrations();
    ok(res, { message: 'Migrations complete' });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

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

// ── SEARCH USERS ─────────────────────────────────────────────
c360Router.get('/auth/search', c360Auth, async (req: C360Req, res) => {
  try {
    const q = (req.query.q as string || '').trim();
    if (!q) { ok(res, []); return; }
    const rows = await query<any>(
      `SELECT id, name, email, role, college, year FROM c360_users
       WHERE is_active=TRUE AND id != $1
       AND (LOWER(name) LIKE LOWER($2) OR LOWER(email) LIKE LOWER($2))
       LIMIT 20`,
      [req.c360User.sub, `%${q}%`]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
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

// ════════════════════════════════════════════════════════════════
// BOOK MARKETPLACE
// ════════════════════════════════════════════════════════════════
c360Router.get('/books', async (req, res) => {
  try {
    const rows = await query<any>(
      `SELECT b.*, u.college as seller_college FROM c360_books b
       LEFT JOIN c360_users u ON u.id=b.seller_id
       WHERE b.status='available' ORDER BY b.created_at DESC`,
      []
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.get('/books/mine', c360Auth, async (req: C360Req, res) => {
  try {
    const rows = await query<any>(
      `SELECT b.*, (SELECT COUNT(*) FROM c360_book_requests r WHERE r.book_id=b.id AND r.status='pending') as pending_requests
       FROM c360_books b WHERE b.seller_id=$1 ORDER BY b.created_at DESC`,
      [req.c360User.sub]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.post('/books', c360Auth, async (req: C360Req, res) => {
  try {
    const { title, author, subject, condition='good', price=0, type='sell', description } = req.body;
    if (!title) { fail(res, 'title required'); return; }
    const seller = await queryOne<any>('SELECT name FROM c360_users WHERE id=$1', [req.c360User.sub]);
    const [book] = await query<any>(
      `INSERT INTO c360_books (seller_id, seller_name, title, author, subject, condition, price, type, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.c360User.sub, seller?.name||'', title, author||null, subject||null, condition, price, type, description||null]
    );
    ok(res, book, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.put('/books/:id/close', c360Auth, async (req: C360Req, res) => {
  try {
    const { status } = req.body; // 'sold' | 'gifted'
    await query(`UPDATE c360_books SET status=$1 WHERE id=$2 AND seller_id=$3`, [status||'sold', req.params.id, req.c360User.sub]);
    ok(res, { updated: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.delete('/books/:id', c360Auth, async (req: C360Req, res) => {
  try {
    await query(`DELETE FROM c360_books WHERE id=$1 AND seller_id=$2`, [req.params.id, req.c360User.sub]);
    ok(res, { deleted: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.post('/books/:id/request', c360Auth, async (req: C360Req, res) => {
  try {
    const { message } = req.body;
    const buyer = await queryOne<any>('SELECT name FROM c360_users WHERE id=$1', [req.c360User.sub]);
    const [r] = await query<any>(
      `INSERT INTO c360_book_requests (book_id, buyer_id, buyer_name, message)
       VALUES ($1,$2,$3,$4) ON CONFLICT (book_id, buyer_id) DO UPDATE SET message=EXCLUDED.message RETURNING *`,
      [req.params.id, req.c360User.sub, buyer?.name||'', message||null]
    );
    ok(res, r, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.get('/books/:id/requests', c360Auth, async (req: C360Req, res) => {
  try {
    const rows = await query<any>(
      `SELECT r.*, u.phone as buyer_phone FROM c360_book_requests r
       JOIN c360_users u ON u.id=r.buyer_id
       JOIN c360_books b ON b.id=r.book_id
       WHERE r.book_id=$1 AND b.seller_id=$2 ORDER BY r.created_at DESC`,
      [req.params.id, req.c360User.sub]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════════
// FRIENDS CIRCLE
// ════════════════════════════════════════════════════════════════
c360Router.get('/friends', c360Auth, async (req: C360Req, res) => {
  try {
    const rows = await query<any>(
      `SELECT f.*,
        CASE WHEN f.from_id=$1 THEN f.to_id ELSE f.from_id END as peer_id,
        CASE WHEN f.from_id=$1 THEN f.to_name ELSE f.from_name END as peer_name
       FROM c360_friends f
       WHERE (f.from_id=$1 OR f.to_id=$1)
       ORDER BY f.created_at DESC`,
      [req.c360User.sub]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.post('/friends/request', c360Auth, async (req: C360Req, res) => {
  try {
    const { toId, toName } = req.body;
    if (!toId) { fail(res, 'toId required'); return; }
    if (toId === req.c360User.sub) { fail(res, 'Cannot add yourself'); return; }
    const me = await queryOne<any>('SELECT name FROM c360_users WHERE id=$1', [req.c360User.sub]);
    const existing = await queryOne<any>(
      `SELECT id, status FROM c360_friends WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)`,
      [req.c360User.sub, toId]
    );
    if (existing) { ok(res, existing); return; }
    const [f] = await query<any>(
      `INSERT INTO c360_friends (from_id, to_id, from_name, to_name) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.c360User.sub, toId, me?.name||'', toName||'']
    );
    ok(res, f, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.put('/friends/:id/accept', c360Auth, async (req: C360Req, res) => {
  try {
    await query(`UPDATE c360_friends SET status='accepted' WHERE id=$1 AND to_id=$2`, [req.params.id, req.c360User.sub]);
    ok(res, { accepted: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.put('/friends/:id/reject', c360Auth, async (req: C360Req, res) => {
  try {
    await query(`DELETE FROM c360_friends WHERE id=$1 AND to_id=$2`, [req.params.id, req.c360User.sub]);
    ok(res, { rejected: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════════
// ALUMNI
// ════════════════════════════════════════════════════════════════
c360Router.get('/alumni', async (_req, res) => {
  try {
    const rows = await query<any>(
      `SELECT a.*, u.email FROM c360_alumni_profiles a
       JOIN c360_users u ON u.id=a.user_id
       ORDER BY a.created_at DESC LIMIT 100`,
      []
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.post('/alumni/register', c360Auth, async (req: C360Req, res) => {
  try {
    const { college, batchYear, currentCompany, jobRole, linkedin, bio } = req.body;
    const me = await queryOne<any>('SELECT name FROM c360_users WHERE id=$1', [req.c360User.sub]);
    const [a] = await query<any>(
      `INSERT INTO c360_alumni_profiles (user_id, user_name, college, batch_year, current_company, job_role, linkedin, bio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id) DO UPDATE SET
         college=EXCLUDED.college, batch_year=EXCLUDED.batch_year,
         current_company=EXCLUDED.current_company, job_role=EXCLUDED.job_role,
         linkedin=EXCLUDED.linkedin, bio=EXCLUDED.bio
       RETURNING *`,
      [req.c360User.sub, me?.name||'', college||null, batchYear||null, currentCompany||null, jobRole||null, linkedin||null, bio||null]
    );
    ok(res, a, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.get('/alumni/my-profile', c360Auth, async (req: C360Req, res) => {
  try {
    const a = await queryOne<any>('SELECT * FROM c360_alumni_profiles WHERE user_id=$1', [req.c360User.sub]);
    ok(res, a || null);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.post('/alumni/invite', c360Auth, async (req: C360Req, res) => {
  try {
    const { toId, toName, message } = req.body;
    if (!toId) { fail(res, 'toId required'); return; }
    const me = await queryOne<any>('SELECT name FROM c360_users WHERE id=$1', [req.c360User.sub]);
    const [inv] = await query<any>(
      `INSERT INTO c360_alumni_invites (from_id, to_id, from_name, to_name, message)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (from_id, to_id) DO UPDATE SET message=EXCLUDED.message
       RETURNING *`,
      [req.c360User.sub, toId, me?.name||'', toName||'', message||null]
    );
    ok(res, inv, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.get('/alumni/invites', c360Auth, async (req: C360Req, res) => {
  try {
    const rows = await query<any>(
      `SELECT * FROM c360_alumni_invites WHERE to_id=$1 AND status='pending' ORDER BY created_at DESC`,
      [req.c360User.sub]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.put('/alumni/invites/:id/respond', c360Auth, async (req: C360Req, res) => {
  try {
    const { action } = req.body; // 'accepted' | 'rejected' | 'hold'
    await query(`UPDATE c360_alumni_invites SET status=$1 WHERE id=$2 AND to_id=$3`, [action, req.params.id, req.c360User.sub]);
    ok(res, { updated: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════════
// ADVERTISEMENTS
// ════════════════════════════════════════════════════════════════
c360Router.get('/ads', async (req, res) => {
  try {
    const placement = req.query.placement as string || 'home';
    const rows = await query<any>(
      `SELECT * FROM c360_ads WHERE is_active=TRUE AND placement=$1 ORDER BY created_at DESC LIMIT 3`,
      [placement]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.post('/ads/:id/click', async (req, res) => {
  try {
    await query(`UPDATE c360_ads SET clicks=clicks+1 WHERE id=$1`, [req.params.id]);
    ok(res, { tracked: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.get('/admin/ads', async (req, res) => {
  if (req.headers['x-admin-key'] !== (process.env.ADMIN_SECRET || 'c360-admin')) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
  try {
    const rows = await query<any>(`SELECT * FROM c360_ads ORDER BY created_at DESC`, []);
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.post('/admin/ads', async (req, res) => {
  if (req.headers['x-admin-key'] !== (process.env.ADMIN_SECRET || 'c360-admin')) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
  try {
    const { title, description, badge, ctaText, ctaUrl, bgGradient='violet', placement='home', createdBy } = req.body;
    if (!title) { fail(res, 'title required'); return; }
    const [ad] = await query<any>(
      `INSERT INTO c360_ads (title, description, badge, cta_text, cta_url, bg_gradient, placement, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [title, description||null, badge||null, ctaText||null, ctaUrl||null, bgGradient, placement, createdBy||'admin']
    );
    ok(res, ad, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.put('/admin/ads/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== (process.env.ADMIN_SECRET || 'c360-admin')) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
  try {
    const { title, description, badge, ctaText, ctaUrl, bgGradient, placement, isActive } = req.body;
    await query(
      `UPDATE c360_ads SET title=COALESCE($1,title), description=COALESCE($2,description),
       badge=COALESCE($3,badge), cta_text=COALESCE($4,cta_text), cta_url=COALESCE($5,cta_url),
       bg_gradient=COALESCE($6,bg_gradient), placement=COALESCE($7,placement),
       is_active=COALESCE($8,is_active) WHERE id=$9`,
      [title||null, description||null, badge||null, ctaText||null, ctaUrl||null, bgGradient||null, placement||null, isActive??null, req.params.id]
    );
    ok(res, { updated: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════════
// WORK PROJECTS (from experts, companies, training centers)
// ════════════════════════════════════════════════════════════════
c360Router.get('/work-projects', async (_req, res) => {
  try {
    const rows = await query<any>(
      `SELECT p.*, (SELECT COUNT(*) FROM c360_work_applications a WHERE a.project_id=p.id) as applicant_count
       FROM c360_work_projects p WHERE p.status='open' ORDER BY p.created_at DESC`,
      []
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.post('/work-projects', c360Auth, async (req: C360Req, res) => {
  try {
    const { title, company, description, skills=[], duration, stipend, spots=1 } = req.body;
    if (!title) { fail(res, 'title required'); return; }
    const me = await queryOne<any>('SELECT name, role FROM c360_users WHERE id=$1', [req.c360User.sub]);
    const [p] = await query<any>(
      `INSERT INTO c360_work_projects (poster_id, poster_name, poster_type, title, company, description, skills, duration, stipend, spots)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.c360User.sub, me?.name||'', me?.role||'mentor', title, company||null, description||null, skills, duration||null, stipend||null, spots]
    );
    ok(res, p, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.post('/work-projects/:id/apply', c360Auth, async (req: C360Req, res) => {
  try {
    const { message } = req.body;
    const me = await queryOne<any>('SELECT name FROM c360_users WHERE id=$1', [req.c360User.sub]);
    const [a] = await query<any>(
      `INSERT INTO c360_work_applications (project_id, applicant_id, applicant_name, message)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id, applicant_id) DO UPDATE SET message=EXCLUDED.message
       RETURNING *`,
      [req.params.id, req.c360User.sub, me?.name||'', message||null]
    );
    ok(res, a, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.get('/work-projects/my-applications', c360Auth, async (req: C360Req, res) => {
  try {
    const rows = await query<any>(
      `SELECT a.*, p.title as project_title, p.company, p.poster_name, p.poster_type, p.stipend
       FROM c360_work_applications a
       JOIN c360_work_projects p ON p.id=a.project_id
       WHERE a.applicant_id=$1 ORDER BY a.applied_at DESC`,
      [req.c360User.sub]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.get('/work-projects/posted', c360Auth, async (req: C360Req, res) => {
  try {
    const rows = await query<any>(
      `SELECT p.*, (SELECT COUNT(*) FROM c360_work_applications a WHERE a.project_id=p.id) as applicant_count
       FROM c360_work_projects p WHERE p.poster_id=$1 ORDER BY p.created_at DESC`,
      [req.c360User.sub]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.get('/work-projects/:id/applicants', c360Auth, async (req: C360Req, res) => {
  try {
    const rows = await query<any>(
      `SELECT a.*, u.college, u.year FROM c360_work_applications a
       JOIN c360_users u ON u.id=a.applicant_id
       JOIN c360_work_projects p ON p.id=a.project_id
       WHERE a.project_id=$1 AND p.poster_id=$2 ORDER BY a.applied_at DESC`,
      [req.params.id, req.c360User.sub]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════════
// COMMUNITY JOB BOARD (student / alumni post jobs)
// ════════════════════════════════════════════════════════════════
c360Router.get('/job-posts', async (_req, res) => {
  try {
    const rows = await query<any>(
      `SELECT * FROM c360_job_posts WHERE status='active' ORDER BY created_at DESC`,
      []
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.get('/job-posts/mine', c360Auth, async (req: C360Req, res) => {
  try {
    const rows = await query<any>(
      `SELECT * FROM c360_job_posts WHERE poster_id=$1 ORDER BY created_at DESC`,
      [req.c360User.sub]
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.post('/job-posts', c360Auth, async (req: C360Req, res) => {
  try {
    const { title, company, location, type='full-time', description, skills=[], applyLink, salary } = req.body;
    if (!title) { fail(res, 'title required'); return; }
    const me = await queryOne<any>('SELECT name, role FROM c360_users WHERE id=$1', [req.c360User.sub]);
    const [p] = await query<any>(
      `INSERT INTO c360_job_posts (poster_id, poster_name, poster_role, title, company, location, type, description, skills, apply_link, salary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.c360User.sub, me?.name||'', me?.role||'student', title, company||null, location||null, type, description||null, skills, applyLink||null, salary||null]
    );
    ok(res, p, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.delete('/job-posts/:id', c360Auth, async (req: C360Req, res) => {
  try {
    await query(`DELETE FROM c360_job_posts WHERE id=$1 AND poster_id=$2`, [req.params.id, req.c360User.sub]);
    ok(res, { deleted: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════════
// IDEA THREADS
// ════════════════════════════════════════════════════════════════
c360Router.get('/ideas', async (_req, res) => {
  try {
    const rows = await query<any>(
      `SELECT i.*,
         (SELECT COUNT(*) FROM c360_idea_contributors c WHERE c.idea_id=i.id AND c.status='accepted') as contributor_count,
         (SELECT COUNT(*) FROM c360_idea_comments co WHERE co.idea_id=i.id) as comment_count
       FROM c360_ideas i ORDER BY i.created_at DESC`,
      []
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.get('/ideas/:id', async (req, res) => {
  try {
    const idea = await queryOne<any>(`SELECT * FROM c360_ideas WHERE id=$1`, [req.params.id]);
    if (!idea) { fail(res, 'Not found', 404); return; }
    const comments = await query<any>(`SELECT * FROM c360_idea_comments WHERE idea_id=$1 ORDER BY created_at ASC`, [req.params.id]);
    const contributors = await query<any>(`SELECT * FROM c360_idea_contributors WHERE idea_id=$1 ORDER BY joined_at ASC`, [req.params.id]);
    ok(res, { ...idea, comments, contributors });
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.post('/ideas', c360Auth, async (req: C360Req, res) => {
  try {
    const { title, description, tags=[] } = req.body;
    if (!title) { fail(res, 'title required'); return; }
    const me = await queryOne<any>('SELECT name FROM c360_users WHERE id=$1', [req.c360User.sub]);
    const [idea] = await query<any>(
      `INSERT INTO c360_ideas (owner_id, owner_name, title, description, tags) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.c360User.sub, me?.name||'', title, description||null, tags]
    );
    ok(res, idea, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.delete('/ideas/:id', c360Auth, async (req: C360Req, res) => {
  try {
    await query(`DELETE FROM c360_ideas WHERE id=$1 AND owner_id=$2`, [req.params.id, req.c360User.sub]);
    ok(res, { deleted: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.put('/ideas/:id/conclude', c360Auth, async (req: C360Req, res) => {
  try {
    const { conclusion } = req.body;
    await query(
      `UPDATE c360_ideas SET status='concluded', conclusion=$1 WHERE id=$2 AND owner_id=$3`,
      [conclusion||null, req.params.id, req.c360User.sub]
    );
    ok(res, { concluded: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.post('/ideas/:id/join', c360Auth, async (req: C360Req, res) => {
  try {
    const me = await queryOne<any>('SELECT name FROM c360_users WHERE id=$1', [req.c360User.sub]);
    const [c] = await query<any>(
      `INSERT INTO c360_idea_contributors (idea_id, user_id, user_name) VALUES ($1,$2,$3)
       ON CONFLICT (idea_id, user_id) DO NOTHING RETURNING *`,
      [req.params.id, req.c360User.sub, me?.name||'']
    );
    ok(res, c || { joined: true }, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.put('/ideas/:id/contributors/:userId/respond', c360Auth, async (req: C360Req, res) => {
  try {
    const { action } = req.body; // 'accepted' | 'rejected'
    const idea = await queryOne<any>('SELECT owner_id FROM c360_ideas WHERE id=$1', [req.params.id]);
    if (!idea || idea.owner_id !== req.c360User.sub) { fail(res, 'Not authorized', 403); return; }
    await query(
      `UPDATE c360_idea_contributors SET status=$1 WHERE idea_id=$2 AND user_id=$3`,
      [action, req.params.id, req.params.userId]
    );
    ok(res, { updated: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

c360Router.post('/ideas/:id/comments', c360Auth, async (req: C360Req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) { fail(res, 'content required'); return; }
    const me = await queryOne<any>('SELECT name FROM c360_users WHERE id=$1', [req.c360User.sub]);
    const [cm] = await query<any>(
      `INSERT INTO c360_idea_comments (idea_id, user_id, user_name, content) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.c360User.sub, me?.name||'', content.trim()]
    );
    ok(res, cm, 201);
  } catch (e: any) { fail(res, e.message, 500); }
});

// ── Admin: view all ideas ─────────────────────────────────────────────────────
c360Router.get('/admin/ideas', async (req, res) => {
  if (req.headers['x-admin-key'] !== (process.env.ADMIN_SECRET || 'c360-admin')) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
  try {
    const rows = await query<any>(
      `SELECT i.*,
         (SELECT COUNT(*) FROM c360_idea_contributors c WHERE c.idea_id=i.id AND c.status='accepted') as contributor_count,
         (SELECT COUNT(*) FROM c360_idea_comments co WHERE co.idea_id=i.id) as comment_count
       FROM c360_ideas i ORDER BY i.created_at DESC`,
      []
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message, 500); }
});
