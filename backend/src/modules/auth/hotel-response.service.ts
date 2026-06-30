// ============================================================
// HOTEL OUTREACH & RESPONSE — Public, token-secured (no user auth)
// Hotel employees respond via a link sent to their email / WhatsApp.
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../config/db';

function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}

export const hotelResponseRouter = Router();

// ── POST /v1/public/hotel-response/outreach
// Customer creates an outreach record → gets back a unique token → embeds in email/WA link
hotelResponseRouter.post('/outreach', async (req, res) => {
  try {
    const { inquiry_id, hotel_name, hotel_email, hotel_phone, city, inquiry_snapshot } = req.body;
    if (!inquiry_id?.trim() || !hotel_name?.trim()) {
      fail(res, 'inquiry_id and hotel_name are required'); return;
    }
    const [row] = await query<any>(
      `INSERT INTO hotel_outreaches
         (inquiry_id, hotel_name, hotel_email, hotel_phone, city, inquiry_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, token, status, created_at`,
      [
        inquiry_id.trim(),
        hotel_name.trim(),
        hotel_email?.trim() || null,
        hotel_phone?.trim()  || null,
        city?.trim()         || null,
        JSON.stringify(inquiry_snapshot || {}),
      ]
    );
    ok(res, row, 201);
  } catch (e: any) { fail(res, e.message); }
});

// ── GET /v1/public/hotel-response/outreach/status?tokens=t1,t2,...
// Customer polls status of multiple outreaches at once (up to 20)
hotelResponseRouter.get('/outreach/status', async (req, res) => {
  try {
    const raw = String(req.query.tokens || '');
    const tokens = raw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 20);
    if (!tokens.length) { ok(res, []); return; }

    const placeholders = tokens.map((_, i) => `$${i + 1}`).join(',');
    const rows = await query<any>(
      `SELECT id, token, inquiry_id, hotel_name, status,
              hotel_action, hotel_quote, hotel_message, hotel_contact_name,
              responded_at, created_at
       FROM hotel_outreaches
       WHERE token::text = ANY(ARRAY[${placeholders}])`,
      tokens
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message); }
});

// ── GET /v1/public/hotel-response/:token
// Hotel employee loads inquiry details (also marks as Viewed)
hotelResponseRouter.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const row = await queryOne<any>(
      `SELECT id, token, inquiry_id, inquiry_snapshot, hotel_name, hotel_email, hotel_phone,
              city, status, hotel_action, hotel_quote, hotel_message, hotel_contact_name,
              responded_at, created_at
       FROM hotel_outreaches WHERE token = $1::uuid`,
      [token]
    );
    if (!row) { fail(res, 'Inquiry not found or link expired', 404); return; }

    // Auto-advance Sent → Viewed
    if (row.status === 'Sent') {
      await query(
        `UPDATE hotel_outreaches SET status='Viewed', updated_at=NOW() WHERE token=$1::uuid`,
        [token]
      );
      row.status = 'Viewed';
    }
    ok(res, row);
  } catch (e: any) {
    // UUID parse error → token is malformed
    if (e.message?.includes('invalid input syntax')) { fail(res, 'Invalid link', 400); return; }
    fail(res, e.message);
  }
});

// ── POST /v1/public/hotel-response/:token/respond
// Hotel employee submits their response
const RespondSchema = z.object({
  contact_name:   z.string().min(1).max(100),
  action:         z.enum(['Accept', 'Quote', 'Hold', 'Reject', 'Future']),
  quote_amount:   z.number().positive().optional(),
  message:        z.string().max(1000).optional(),
});

hotelResponseRouter.post('/:token/respond', async (req, res) => {
  try {
    const { token } = req.params;
    const body = RespondSchema.parse(req.body);

    const existing = await queryOne<any>(
      'SELECT id, status FROM hotel_outreaches WHERE token=$1::uuid',
      [token]
    );
    if (!existing) { fail(res, 'Inquiry not found or link expired', 404); return; }
    if (existing.status === 'Responded') {
      fail(res, 'You have already responded to this inquiry', 409); return;
    }

    const [row] = await query<any>(
      `UPDATE hotel_outreaches
       SET status          = 'Responded',
           hotel_action    = $1,
           hotel_quote     = $2,
           hotel_message   = $3,
           hotel_contact_name = $4,
           responded_at    = NOW(),
           updated_at      = NOW()
       WHERE token = $5::uuid
       RETURNING id, token, inquiry_id, hotel_name, status, hotel_action, hotel_quote,
                 hotel_message, hotel_contact_name, responded_at`,
      [body.action, body.quote_amount ?? null, body.message ?? null, body.contact_name, token]
    );
    ok(res, row);
  } catch (e: any) {
    if (e.message?.includes('invalid input syntax')) { fail(res, 'Invalid link', 400); return; }
    if (e instanceof z.ZodError) { fail(res, e.errors[0]?.message || 'Validation error'); return; }
    fail(res, e.message);
  }
});
