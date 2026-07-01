// ============================================================
// WorkflowAgent / OrganizerAgent — Booking & Matching Service
// Handles: create booking → match vendors → notify via WhatsApp
//          → track responses → notify seeker → closure
// Public routes: no auth required (phone-based identity)
// ============================================================

import { Router } from 'express';
import { query, queryOne } from '../../config/db';
import { sendWhatsAppText, normalizeWhatsAppPhone } from '../../utils/whatsapp';

export const workflowRouter = Router();

function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}

// ── Notification helpers ──────────────────────────────────────

export async function createNotification(opts: {
  phone: string;
  type: string;
  title: string;
  body?: string;
  action_type?: string;
  action_data?: Record<string, any>;
  ref_type?: string;
  ref_id?: string;
}) {
  await query(
    `INSERT INTO notifications (phone, type, title, body, action_type, action_data, ref_type, ref_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      opts.phone,
      opts.type,
      opts.title,
      opts.body || null,
      opts.action_type || null,
      JSON.stringify(opts.action_data || {}),
      opts.ref_type || null,
      opts.ref_id || null,
    ]
  );
}

// ── Vendor WhatsApp notification ──────────────────────────────

async function notifyVendor(matchId: string, req: any, vendor: { name: string; phone: string }) {
  const dateRange = req.date_start
    ? `${req.date_start}${req.date_end && req.date_end !== req.date_start ? ` to ${req.date_end}` : ''}`
    : null;

  const lines = [
    `📋 *New Booking Request — Action Required*`,
    ``,
    `Service: *${req.vendor_type || req.title}*`,
    `Location: *${req.city || 'Not specified'}*`,
    dateRange ? `Dates: *${dateRange}*` : null,
    req.budget ? `Budget: *₹${Number(req.budget).toLocaleString('en-IN')}*` : null,
    req.description ? `Notes: ${req.description}` : null,
    ``,
    `Reply with:`,
    `✅ *YES* — to accept this booking`,
    `❌ *NO* — to decline`,
    `💬 *COMMENT <your message>* — to ask a question or give a quote`,
    ``,
    `_This request was sent to you by DemandGenius._`,
  ].filter(Boolean).join('\n');

  const result = await sendWhatsAppText(vendor.phone, lines);

  if (result.sent || result.skipped) {
    await query(
      `UPDATE workflow_vendor_matches SET wa_notified_at = NOW(), status = 'notified' WHERE id = $1`,
      [matchId]
    );
  }
  return result;
}

// ── Find matching vendors ─────────────────────────────────────

async function findVendors(vendorType: string, city: string, limit = 5) {
  // Stem plural (hotels → hotel)
  const stem = vendorType.toLowerCase().endsWith('s') && vendorType.length > 4
    ? vendorType.slice(0, -1) : vendorType;

  const rows = await query<any>(
    `SELECT id::text AS id, name, phone, city, 'listing' AS vendor_type
     FROM public_listings
     WHERE is_active = TRUE
       AND phone IS NOT NULL AND phone != ''
       AND (
         type ILIKE $1 OR type ILIKE $2
         OR description ILIKE $1 OR description ILIKE $2
       )
       AND (
         city ILIKE $3
         OR description ILIKE $3
         OR address ILIKE $3
       )
     LIMIT $4`,
    [`%${vendorType}%`, `%${stem}%`, `%${city}%`, limit]
  );

  return rows;
}

// ── GET /v1/public/wa-status — WhatsApp diagnostic ───────────

workflowRouter.get('/wa-status', (_req, res) => {
  const enabled    = process.env.ENABLE_WHATSAPP === 'true';
  const hasPhone   = !!process.env.WHATSAPP_PHONE_NUMBER_ID;
  const hasToken   = !!process.env.WHATSAPP_ACCESS_TOKEN;
  const configured = hasPhone && hasToken;
  return ok(res, {
    whatsapp_enabled: enabled,
    configured,
    phone_number_id_set: hasPhone,
    access_token_set: hasToken,
    will_send: enabled && configured,
    hint: !enabled ? 'Set ENABLE_WHATSAPP=true in Render env vars'
        : !configured ? 'Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN in Render env vars'
        : 'WhatsApp is ready',
  });
});

// ── POST /v1/public/bookings ──────────────────────────────────
// Seeker submits a booking request → system finds vendors + notifies

workflowRouter.post('/bookings', async (req, res) => {
  try {
    const {
      vendor_type, city, date_start, date_end, budget,
      seeker_name, seeker_phone, seeker_email,
      description, title,
    } = req.body;

    if (!vendor_type?.trim() || !city?.trim()) {
      return fail(res, 'vendor_type and city are required');
    }
    if (!seeker_phone?.trim()) {
      return fail(res, 'seeker_phone is required to receive booking updates');
    }

    const reqTitle = title?.trim() || `${vendor_type} booking in ${city}`;

    // Create workflow request
    const [wfRow] = await query<any>(
      `INSERT INTO workflow_requests
         (type, title, description, city, vendor_type, date_start, date_end, budget,
          seeker_name, seeker_phone, seeker_email, status)
       VALUES ('booking',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
       RETURNING id`,
      [
        reqTitle,
        description?.trim() || null,
        city.trim(),
        vendor_type.trim(),
        date_start || null,
        date_end   || null,
        budget     || null,
        seeker_name?.trim()  || null,
        normalizeWhatsAppPhone(seeker_phone),
        seeker_email?.trim() || null,
      ]
    );

    const requestId = wfRow.id;

    // Find matching vendors
    const vendors = await findVendors(vendor_type.trim(), city.trim());
    let notifiedCount = 0;

    for (const v of vendors) {
      const [match] = await query<any>(
        `INSERT INTO workflow_vendor_matches
           (request_id, vendor_type, vendor_id, vendor_name, vendor_phone, vendor_city)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [requestId, v.vendor_type, v.id, v.name, v.phone, v.city]
      );

      if (v.phone) {
        await notifyVendor(match.id, { ...req.body, vendor_type, city }, v);
        notifiedCount++;
      }
    }

    // Update matched count + status
    await query(
      `UPDATE workflow_requests SET matched_count=$1, status=$2, updated_at=NOW() WHERE id=$3`,
      [vendors.length, vendors.length > 0 ? 'matching' : 'no_vendors', requestId]
    );

    // Notify seeker via WhatsApp + in-app notification
    const seekerPhone = normalizeWhatsAppPhone(seeker_phone);
    const seekerMsg = vendors.length > 0
      ? `✅ *Booking Request Received!*\n\nWe found ${vendors.length} ${vendor_type}(s) in ${city} and have sent them your request.\n\nYou'll get updates here as vendors respond.\n\nTracking ID: ${requestId.slice(0, 8)}`
      : `✅ *Booking Request Received!*\n\nWe're searching for ${vendor_type}s in ${city}. Our team will reach out with options shortly.\n\nTracking ID: ${requestId.slice(0, 8)}`;

    await sendWhatsAppText(seekerPhone, seekerMsg);

    await createNotification({
      phone: seekerPhone,
      type: 'booking_created',
      title: `Booking request sent`,
      body: vendors.length > 0
        ? `Notified ${notifiedCount} vendor(s). Waiting for responses.`
        : `Request registered. We'll find vendors shortly.`,
      action_type: 'view',
      action_data: { requestId },
      ref_type: 'workflow_request',
      ref_id: requestId,
    });

    return ok(res, { requestId, vendorsFound: vendors.length, notified: notifiedCount }, 201);
  } catch (e: any) {
    console.error('[workflow] Error creating booking:', e.message);
    return fail(res, e.message);
  }
});

// ── GET /v1/public/bookings/:id ───────────────────────────────

workflowRouter.get('/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const wf = await queryOne<any>(
      `SELECT id, type, title, description, city, vendor_type, date_start, date_end,
              budget, seeker_name, seeker_phone, seeker_email, status, matched_count, notes, created_at
       FROM workflow_requests WHERE id = $1`,
      [id]
    );
    if (!wf) return fail(res, 'Booking not found', 404);

    const matches = await query<any>(
      `SELECT id, vendor_name, vendor_city, vendor_type, status, notes, quote_amount, responded_at, wa_notified_at
       FROM workflow_vendor_matches
       WHERE request_id = $1
       ORDER BY status DESC, created_at`,
      [id]
    );

    return ok(res, { ...wf, vendors: matches });
  } catch (e: any) {
    return fail(res, e.message);
  }
});

// ── GET /v1/public/bookings?phone=xxx ────────────────────────
// Seeker's booking history

workflowRouter.get('/bookings', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').replace(/\D/g, '');
    if (!phone) return fail(res, 'phone is required');

    const rows = await query<any>(
      `SELECT id, type, title, city, vendor_type, date_start, date_end,
              budget, status, matched_count, created_at
       FROM workflow_requests
       WHERE seeker_phone = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [phone]
    );
    return ok(res, rows);
  } catch (e: any) {
    return fail(res, e.message);
  }
});

// ── GET /v1/public/notifications?phone=xxx ───────────────────

workflowRouter.get('/notifications', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').replace(/\D/g, '');
    if (!phone) return fail(res, 'phone is required');

    const rows = await query<any>(
      `SELECT id, type, title, body, action_type, action_data, ref_type, ref_id, is_read, created_at
       FROM notifications
       WHERE phone = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [phone]
    );
    const unread = rows.filter((r: any) => !r.is_read).length;
    return ok(res, { notifications: rows, unread });
  } catch (e: any) {
    return fail(res, e.message);
  }
});

// ── PATCH /v1/public/notifications/:id/read ──────────────────

workflowRouter.patch('/notifications/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    await query(
      `UPDATE notifications SET is_read = TRUE, read_at = NOW() WHERE id = $1`,
      [id]
    );
    return ok(res, { id, read: true });
  } catch (e: any) {
    return fail(res, e.message);
  }
});

// ── PATCH /v1/public/notifications/read-all ──────────────────

workflowRouter.patch('/notifications/read-all', async (req, res) => {
  try {
    const phone = String(req.body.phone || '').replace(/\D/g, '');
    if (!phone) return fail(res, 'phone is required');
    await query(
      `UPDATE notifications SET is_read = TRUE, read_at = NOW() WHERE phone = $1 AND is_read = FALSE`,
      [phone]
    );
    return ok(res, { updated: true });
  } catch (e: any) {
    return fail(res, e.message);
  }
});

// ── Vendor response handler (called from WhatsApp webhook) ────

export async function handleVendorWorkflowReply(
  vendorPhone: string,
  text: string
): Promise<boolean> {
  const lower = text.toLowerCase().trim();
  const isYes = lower === 'yes' || lower === 'accept' || lower === 'ok';
  const isNo  = lower === 'no'  || lower === 'reject' || lower === 'decline';
  const commentMatch = lower.match(/^(?:comment|quote|msg|message)\s+(.+)/s);

  if (!isYes && !isNo && !commentMatch) return false;

  // Find the most recent pending/notified match for this vendor phone
  const match = await queryOne<any>(
    `SELECT wm.*, wr.title, wr.vendor_type, wr.city, wr.date_start, wr.date_end,
            wr.budget, wr.seeker_phone, wr.seeker_name, wr.id AS request_id
     FROM workflow_vendor_matches wm
     JOIN workflow_requests wr ON wr.id = wm.request_id
     WHERE wm.vendor_phone = $1
       AND wm.status IN ('pending','notified','discussing')
     ORDER BY wm.created_at DESC
     LIMIT 1`,
    [vendorPhone]
  );

  if (!match) return false;

  const vendorName = match.vendor_name || vendorPhone;

  if (isYes) {
    await query(
      `UPDATE workflow_vendor_matches
       SET status='accepted', responded_at=NOW()
       WHERE id = $1`,
      [match.id]
    );
    await query(
      `UPDATE workflow_requests SET status='confirmed', updated_at=NOW() WHERE id=$1`,
      [match.request_id]
    );

    // Notify vendor
    await sendWhatsAppText(vendorPhone,
      `✅ *Booking Accepted!*\n\nThank you for accepting the ${match.vendor_type || 'service'} request in ${match.city}.\n\nThe seeker will be notified. We will share contact details once the booking is confirmed via the app.`
    );

    // Notify seeker (no phone number shown — respect security policy)
    const seekerPhone = match.seeker_phone;
    if (seekerPhone) {
      await sendWhatsAppText(seekerPhone,
        `🎉 *Good news, ${match.seeker_name || 'there'}!*\n\n*${vendorName}* has accepted your ${match.vendor_type || 'service'} request in ${match.city}.\n\nThey will be in touch soon. You can also view full details in the app:\nhttps://demandgenius.vercel.app/explore`
      );
      await createNotification({
        phone: seekerPhone,
        type: 'vendor_accepted',
        title: `${vendorName} accepted your booking`,
        body: `Your ${match.vendor_type} request in ${match.city} has been accepted.`,
        action_type: 'view',
        action_data: { requestId: match.request_id, matchId: match.id },
        ref_type: 'workflow_vendor_match',
        ref_id: match.id,
      });
    }
    return true;
  }

  if (isNo) {
    await query(
      `UPDATE workflow_vendor_matches SET status='rejected', responded_at=NOW() WHERE id=$1`,
      [match.id]
    );
    await sendWhatsAppText(vendorPhone,
      `✅ *Got it.* You've declined this request. No further action needed.\n\nIf you change your mind, reply *YES* before the booking date.`
    );

    const seekerPhone = match.seeker_phone;
    if (seekerPhone) {
      await createNotification({
        phone: seekerPhone,
        type: 'vendor_rejected',
        title: `A vendor declined your booking`,
        body: `${vendorName} is unavailable for your ${match.vendor_type} request. Looking for alternatives.`,
        action_type: 'view',
        action_data: { requestId: match.request_id },
        ref_type: 'workflow_request',
        ref_id: match.request_id,
      });
    }
    return true;
  }

  if (commentMatch) {
    const note = text.replace(/^(?:comment|quote|msg|message)\s+/i, '').trim();
    const isQuote = lower.startsWith('quote');
    const quoteAmt = isQuote ? parseFloat(note.replace(/[^0-9.]/g, '')) || null : null;

    await query(
      `UPDATE workflow_vendor_matches
       SET status='discussing', notes=$1, quote_amount=$2, responded_at=NOW()
       WHERE id=$3`,
      [note, quoteAmt, match.id]
    );

    await sendWhatsAppText(vendorPhone,
      `✅ *Message received.* The seeker has been notified of your message.`
    );

    const seekerPhone = match.seeker_phone;
    if (seekerPhone) {
      const title = isQuote && quoteAmt
        ? `${vendorName} quoted ₹${quoteAmt.toLocaleString('en-IN')}`
        : `${vendorName} sent a message`;

      await sendWhatsAppText(seekerPhone,
        `💬 *Message from ${vendorName}:*\n\n"${note}"\n\nReply in the app to continue the conversation:\nhttps://demandgenius.vercel.app/explore`
      );
      await createNotification({
        phone: seekerPhone,
        type: 'vendor_message',
        title,
        body: note,
        action_type: 'view',
        action_data: { requestId: match.request_id, matchId: match.id, quote: quoteAmt },
        ref_type: 'workflow_vendor_match',
        ref_id: match.id,
      });
    }
    return true;
  }

  return false;
}
