// ============================================================
// WhatsApp Cloud API — Inbound Webhook + Search Bot
// ============================================================
// Required .env vars:
//   ENABLE_WHATSAPP=true
//   WHATSAPP_API_VERSION=v21.0
//   WHATSAPP_PHONE_NUMBER_ID=<from Meta Dev Console>
//   WHATSAPP_ACCESS_TOKEN=<permanent system user token>
//   WHATSAPP_VERIFY_TOKEN=<any random string you choose>
//   WHATSAPP_APP_SECRET=<your Meta app secret>
//
// Webhook URL to register in Meta:  POST /v1/webhooks/whatsapp
// ============================================================

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query, queryOne } from '../../config/db';
import { sendWhatsAppText, normalizeWhatsAppPhone } from '../../utils/whatsapp';
import { metaConfig, botFooter } from './meta.config';
import bcrypt from 'bcryptjs';

export const waWebhookRouter = Router();

const VERIFY_TOKEN = metaConfig.verifyToken;
const APP_SECRET   = metaConfig.appSecret;
const footer       = botFooter;

// ── Signature verification ────────────────────────────────────
function verifySignature(rawBody: Buffer, signature: string): boolean {
  if (!APP_SECRET) return true; // skip in dev if not configured
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)); }
  catch { return false; }
}

// ── GET — Meta webhook verification challenge ─────────────────
waWebhookRouter.get('/', (req: Request, res: Response) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[WA] Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── POST — Receive messages ───────────────────────────────────
waWebhookRouter.post('/', async (req: Request, res: Response) => {
  // Verify signature using raw body (express.raw middleware must be applied upstream)
  const sig = req.headers['x-hub-signature-256'] as string || '';
  const rawBody: Buffer = (req as any).rawBody;
  if (rawBody && sig && !verifySignature(rawBody, sig)) {
    console.warn('[WA] Invalid signature — rejected');
    return res.sendStatus(403);
  }

  // Acknowledge immediately (Meta requires 200 within 20s)
  res.sendStatus(200);

  try {
    const body = req.body;
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    if (changes?.field !== 'messages') return;

    const value    = changes.value;
    const messages = value?.messages;
    if (!messages?.length) return;

    for (const msg of messages) {
      if (msg.type !== 'text') {
        await sendWhatsAppText(msg.from, '👋 I can only understand text messages right now.\nType *help* to see what I can do.');
        continue;
      }

      const waPhone = normalizeWhatsAppPhone(msg.from);
      const text    = (msg.text?.body || '').trim();

      await handleMessage(waPhone, text);
    }
  } catch (e: any) {
    console.error('[WA] Error processing webhook:', e.message);
  }
});

// ── Session helpers ───────────────────────────────────────────
async function getSession(waPhone: string) {
  return queryOne<any>(
    `SELECT ws.*, u.first_name, u.last_name, u.role,
            t.name AS tenant_name, s.name AS store_name, t.industry_id
     FROM wa_sessions ws
     JOIN users u ON u.id = ws.user_id
     JOIN tenants t ON t.id = ws.tenant_id
     JOIN stores s ON s.id = ws.store_id
     WHERE ws.wa_phone = $1`,
    [waPhone]
  );
}

async function touchSession(waPhone: string) {
  await query(`UPDATE wa_sessions SET last_seen_at = NOW() WHERE wa_phone = $1`, [waPhone]);
}

// ── Main message handler ──────────────────────────────────────
async function handleMessage(waPhone: string, text: string) {
  const lower = text.toLowerCase().trim();

  // ── Link command: link email password ──
  if (lower.startsWith('link ')) {
    await handleLink(waPhone, text.slice(5).trim());
    return;
  }

  // ── Logout ──
  if (lower === 'logout' || lower === 'unlink') {
    await handleLogout(waPhone);
    return;
  }

  // ── Help (always available) ──
  if (lower === 'help' || lower === 'hi' || lower === 'hello' || lower === 'start') {
    await sendWhatsAppText(waPhone, helpText());
    return;
  }

  // ── Explore / stores (public, no login needed) ──
  if (lower === 'stores' || lower === 'explore' || lower.startsWith('stores ')) {
    const city = lower.startsWith('stores ') ? text.slice(7).trim() : '';
    await handleExploreStores(waPhone, city);
    return;
  }

  const session = await getSession(waPhone);

  // ── Authenticated commands ──
  if (session) {
    await touchSession(waPhone);

    if (lower === 'today' || lower === 'sales today' || lower === 'today sales') {
      await handleTodaySummary(waPhone, session); return;
    }
    if (lower === 'low stock' || lower === 'lowstock' || lower === 'reorder') {
      await handleLowStock(waPhone, session); return;
    }
    if (lower === 'me' || lower === 'account' || lower === 'whoami') {
      await sendWhatsAppText(waPhone,
        `👤 *Your Account*\n\n` +
        `Name: ${session.first_name} ${session.last_name}\n` +
        `Role: ${session.role}\n` +
        `Business: ${session.tenant_name}\n` +
        `Store: ${session.store_name}\n\n` +
        `Type *help* for all commands.\n` +
        footer('Manage inventory, orders & reports on the web.')
      );
      return;
    }
    const searchTerm = extractSearchTerm(lower, text);
    if (searchTerm) {
      await handleSearch(waPhone, session, searchTerm); return;
    }
    await sendWhatsAppText(waPhone,
      `🤔 I didn't understand that.\n\nType *help* to see all commands, or just type a product name to search.\n` +
      footer()
    );
    return;
  }

  // ── Not logged in — try public search for any keyword ──
  const searchTerm = extractSearchTerm(lower, text);
  if (searchTerm) {
    await handlePublicSearch(waPhone, searchTerm);
    return;
  }

  await sendWhatsAppText(waPhone,
    `👋 *Welcome to DemandPlanning!*\n\n` +
    `Your AI-powered store assistant — search products, check stock, and explore nearby stores across Grocery, Pharma, Auto Parts & Tea.\n\n` +
    `*Try these right now:*\n` +
    `  🔍 Type any product name — _rice, paracetamol, oil filter_\n` +
    `  🏪 *stores* — browse all stores\n` +
    `  🏪 *stores bangalore* — filter by city\n` +
    `  🔐 *link {email} {password}* — connect your store account\n\n` +
    `Type *help* for all commands.\n` +
    footer('Phone numbers & live stock levels are available after login.')
  );
}

// ── Link handler ──────────────────────────────────────────────
async function handleLink(waPhone: string, args: string) {
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    await sendWhatsAppText(waPhone, `❌ Usage: *link {email} {password}*\n\nExample:\nlink owner@shop.com MyPassword123`);
    return;
  }

  const email    = parts[0].toLowerCase();
  const password = parts.slice(1).join(' ');

  const user = await queryOne<any>(
    `SELECT u.*, s.id AS store_id, s.name AS store_name FROM users u
     LEFT JOIN stores s ON s.tenant_id = u.tenant_id AND s.is_active = TRUE
     WHERE u.email = $1 AND u.is_active = TRUE
     LIMIT 1`,
    [email]
  );

  if (!user) {
    await sendWhatsAppText(waPhone, `❌ Account not found or inactive. Check your email and try again.`);
    return;
  }

  const valid = await bcrypt.compare(password, user.password_hash || '');
  if (!valid) {
    await sendWhatsAppText(waPhone, `❌ Incorrect password. Please try again.`);
    return;
  }

  // Upsert session
  await query(
    `INSERT INTO wa_sessions (wa_phone, user_id, tenant_id, store_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (wa_phone) DO UPDATE
       SET user_id=$2, tenant_id=$3, store_id=$4, last_seen_at=NOW()`,
    [waPhone, user.id, user.tenant_id, user.store_id]
  );

  await sendWhatsAppText(waPhone,
    `✅ *Linked successfully!*\n\nWelcome, *${user.first_name}*! 👋\n\n` +
    `📦 Store: *${user.store_name || 'your store'}*\n\n` +
    `*What you can do now:*\n` +
    `  🔍 Search your inventory — _just type a product name_\n` +
    `  ⚠️ *low stock* — items below reorder level\n` +
    `  📊 *today* — today's sales summary\n` +
    `  👤 *me* — your account info\n` +
    `  🚪 *logout* — unlink this number\n` +
    footer('Manage your full inventory and orders on the web.')
  );
}

// ── Logout handler ────────────────────────────────────────────
async function handleLogout(waPhone: string) {
  await query(`DELETE FROM wa_sessions WHERE wa_phone = $1`, [waPhone]);
  await sendWhatsAppText(waPhone,
    `✅ *Unlinked successfully.*\n\nYour number is no longer connected to any store account.\n\n` +
    `To reconnect: *link {email} {password}*\n` +
    footer('You can still search products and browse stores without logging in.')
  );
}

// ── Search handler ────────────────────────────────────────────
async function handleSearch(waPhone: string, session: any, term: string) {
  const results = await query<any>(
    `SELECT
       i.name, i.sku, i.brand,
       i.current_stock, i.selling_price, i.mrp,
       i.reorder_level,
       COALESCE(u.symbol, '') AS unit,
       COALESCE(c.name, '') AS category,
       i.rack_location
     FROM items i
     LEFT JOIN unit_types u ON u.id = i.primary_unit_id
     LEFT JOIN categories c ON c.id = i.category_id
     WHERE i.store_id = $1
       AND i.is_active = TRUE
       AND (
         i.name ILIKE $2
         OR i.brand ILIKE $2
         OR i.sku ILIKE $2
         OR i.description ILIKE $2
         OR COALESCE(i.rack_location, '') ILIKE $2
       )
     ORDER BY
       CASE WHEN i.name ILIKE $3 THEN 0 ELSE 1 END,
       i.name
     LIMIT ${metaConfig.bot.maxPrivateResults}`,
    [session.store_id, `%${term}%`, `${term}%`]
  );

  if (!results.length) {
    await sendWhatsAppText(waPhone,
      `🔍 No results found for *"${term}"* in your store.\n\nTry a different spelling or shorter keyword.\n` +
      footer('Search products across all stores on our explore page.')
    );
    return;
  }

  const lines: string[] = [`🔍 *${results.length} result${results.length > 1 ? 's' : ''} for "${term}"* — ${session.store_name}\n`];

  for (const item of results) {
    const stock = item.current_stock != null ? Number(item.current_stock) : null;
    const stockStr = stock === null ? 'N/A'
      : stock <= 0 ? '❌ Out of stock'
      : (item.reorder_level && stock <= Number(item.reorder_level)) ? `⚠️ Low: ${stock} ${item.unit}`
      : `✅ ${stock} ${item.unit}`;

    const priceStr = item.selling_price ? `  ₹${Number(item.selling_price).toFixed(0)}` : '';
    const brandStr = item.brand ? ` | ${item.brand}` : '';
    const skuStr   = item.sku ? ` (${item.sku})` : '';
    const locStr   = item.rack_location ? `  📍 Rack: ${item.rack_location}` : '';
    const catStr   = item.category ? ` [${item.category}]` : '';

    lines.push(
      `*${item.name}*${skuStr}${brandStr}${catStr}`,
      `${stockStr}${priceStr}${locStr}`,
      ''
    );
  }
  lines.push(footer('View full inventory & place orders on the web.'));
  await sendWhatsAppText(waPhone, lines.join('\n').trimEnd());
}

// ── Low stock handler ─────────────────────────────────────────
async function handleLowStock(waPhone: string, session: any) {
  const results = await query<any>(
    `SELECT i.name, i.sku, i.current_stock, i.reorder_level,
            COALESCE(u.symbol, '') AS unit, COALESCE(c.name, '') AS category
     FROM items i
     LEFT JOIN unit_types u ON u.id = i.primary_unit_id
     LEFT JOIN categories c ON c.id = i.category_id
     WHERE i.store_id = $1 AND i.is_active = TRUE
       AND i.reorder_level IS NOT NULL
       AND i.current_stock <= i.reorder_level
     ORDER BY (i.current_stock - i.reorder_level) ASC
     LIMIT ${metaConfig.bot.maxLowStockResults}`,
    [session.store_id]
  );

  if (!results.length) {
    await sendWhatsAppText(waPhone,
      `✅ *All items are above reorder level!*\n\nNo low stock alerts for *${session.store_name}* right now.\n` +
      footer('View full inventory analytics on the web.')
    );
    return;
  }

  const lines: string[] = [`⚠️ *Low Stock Alert — ${results.length} item${results.length > 1 ? 's' : ''} in ${session.store_name}*\n`];
  for (const item of results) {
    const stock = Number(item.current_stock);
    const reorder = Number(item.reorder_level);
    const gap = reorder - stock;
    const skuStr = item.sku ? ` (${item.sku})` : '';
    lines.push(`*${item.name}*${skuStr}  [${item.category}]`);
    lines.push(`Stock: ${stock} ${item.unit}  |  Reorder at: ${reorder}  |  Order +${gap} more`);
    lines.push('');
  }
  lines.push(footer('Raise purchase orders and restock easily on the web.'));
  await sendWhatsAppText(waPhone, lines.join('\n').trimEnd());
}

// ── Today's sales summary ─────────────────────────────────────
async function handleTodaySummary(waPhone: string, session: any) {
  const today = new Date().toISOString().slice(0, 10);

  const [summary] = await query<any>(
    `SELECT
       COUNT(*)::int AS total_bills,
       COALESCE(SUM(total_amount), 0) AS total_revenue,
       COALESCE(SUM(total_items), 0) AS total_items
     FROM sales
     WHERE store_id = $1 AND DATE(created_at) = $2`,
    [session.store_id, today]
  );

  const rev   = Number(summary?.total_revenue || 0);
  const bills = summary?.total_bills || 0;
  const items = summary?.total_items || 0;

  await sendWhatsAppText(waPhone,
    `📊 *Today's Summary — ${today}*\n` +
    `_${session.store_name}_\n\n` +
    `🧾 Bills: *${bills}*\n` +
    `📦 Items Sold: *${items}*\n` +
    `💰 Revenue: *₹${rev.toLocaleString('en-IN')}*\n\n` +
    (bills === 0 ? '_No sales recorded yet today._\n' : `_Avg bill: ₹${bills ? (rev / bills).toFixed(0) : 0}_\n`) +
    footer('View detailed reports, charts & trends on the web.')
  );
}

// ── Public item search (no login) ────────────────────────────
async function handlePublicSearch(waPhone: string, term: string) {
  const results = await query<any>(
    `SELECT i.name, i.brand, i.selling_price,
            i.current_stock > 0 AS in_stock,
            COALESCE(c.name, '') AS category,
            COALESCE(u.symbol, '') AS unit,
            s.name AS store_name, s.city
     FROM items i
     LEFT JOIN categories c ON c.id = i.category_id
     LEFT JOIN unit_types u ON u.id = i.primary_unit_id
     JOIN stores s ON s.id = i.store_id
     JOIN tenants t ON t.id = i.tenant_id
     WHERE i.is_active = TRUE AND s.is_active = TRUE AND t.is_active = TRUE
       AND (i.name ILIKE $1 OR i.brand ILIKE $1 OR i.sku ILIKE $1)
     ORDER BY CASE WHEN i.name ILIKE $2 THEN 0 ELSE 1 END, s.name, i.name
     LIMIT ${metaConfig.bot.maxPublicResults}`,
    [`%${term}%`, `${term}%`]
  );

  if (!results.length) {
    await sendWhatsAppText(waPhone,
      `🔍 No results found for *"${term}"*\n\n` +
      `Try a shorter keyword or different spelling.\n` +
      `_Examples: rice, amul, paracetamol, oil filter, spark plug_\n` +
      footer('Browse all stores and their full product catalogue online.')
    );
    return;
  }

  const lines: string[] = [`🔍 *${results.length} result${results.length > 1 ? 's' : ''} for "${term}"*\n`];
  for (const item of results) {
    const stock = item.in_stock ? '✅ Available' : '❌ Out of stock';
    const price = item.selling_price ? `  ₹${Number(item.selling_price).toFixed(0)}` : '';
    const brand = item.brand ? ` | ${item.brand}` : '';
    const loc   = item.city ? `, ${item.city}` : '';
    lines.push(`*${item.name}*${brand}`, `${stock}${price}  📍 ${item.store_name}${loc}`, '');
  }
  lines.push(
    `📞 _Phone numbers & stock quantities visible after login_`,
    footer('Login for live stock levels, prices & direct contact.')
  );
  await sendWhatsAppText(waPhone, lines.join('\n').trimEnd());
}

// ── Public store explorer ─────────────────────────────────────
async function handleExploreStores(waPhone: string, city: string) {
  const vals: any[] = [];
  let where = `WHERE s.is_active = TRUE AND t.is_active = TRUE AND s.city IS NOT NULL`;
  if (city) { where += ` AND s.city ILIKE $1`; vals.push(`%${city}%`); }

  const stores = await query<any>(
    `SELECT s.name AS store_name, s.city, s.state,
            COALESCE(ic.display_name, 'General') AS industry,
            (SELECT COUNT(*)::int FROM items it WHERE it.store_id = s.id AND it.is_active = TRUE) AS product_count
     FROM stores s
     JOIN tenants t ON t.id = s.tenant_id
     LEFT JOIN tenant_industries ti ON ti.tenant_id = t.id
     LEFT JOIN industry_configs ic ON ic.id = ti.industry_id
     ${where} ORDER BY s.name LIMIT ${metaConfig.bot.maxStoreResults}`,
    vals
  );

  if (!stores.length) {
    await sendWhatsAppText(waPhone,
      `🏪 No stores found${city ? ` in *${city}*` : ''}.\n\n` +
      `Try: *stores bangalore*  •  *stores nilgiris*  •  *stores chennai*\n` +
      footer('See all registered stores on our explore page.')
    );
    return;
  }

  const lines: string[] = [`🏪 *${stores.length} store${stores.length > 1 ? 's' : ''}${city ? ' in ' + city : ' — all cities'}*\n`];
  for (const s of stores) {
    const loc = [s.city, s.state].filter(Boolean).join(', ');
    lines.push(
      `*${s.store_name}*  [${s.industry}]`,
      `📍 ${loc}  •  ${s.product_count} products`,
      `📞 _Contact details available for registered users_`,
      ''
    );
  }
  lines.push(
    `💡 *Search products across all stores — just type a name*`,
    `_e.g: rice, paracetamol, oil filter, amul_`,
    footer('View store profiles, products & contact info online.')
  );
  await sendWhatsAppText(waPhone, lines.join('\n').trimEnd());
}

// ── Search term extractor ─────────────────────────────────────
function extractSearchTerm(lower: string, original: string): string | null {
  const prefixes = ['search ', 'find ', 'stock ', 'show ', 'check ', 's ', 'item '];
  for (const p of prefixes) {
    if (lower.startsWith(p)) return original.slice(p.length).trim();
  }
  // Bare keyword: at least 2 chars, not a known command
  const commands = new Set(['today', 'help', 'hi', 'hello', 'start', 'me', 'account', 'whoami', 'logout', 'unlink', 'low stock', 'lowstock', 'reorder', 'sales today', 'today sales']);
  if (!commands.has(lower) && lower.length >= 2) return original.trim();
  return null;
}

// ── Help text ─────────────────────────────────────────────────
function helpText(): string {
  return (
    `📦 *DemandPlanning — AI Store Assistant*\n` +
    `_Grocery • Pharma • Auto Parts • Tea & more_\n\n` +
    `*🔍 Search products (no login needed):*\n` +
    `  rice  •  paracetamol  •  oil filter\n` +
    `  _Just type any product name_\n\n` +
    `*🏪 Browse stores (no login needed):*\n` +
    `  *stores* — see all registered stores\n` +
    `  *stores bangalore* — filter by city\n\n` +
    `*🔐 Connect your store account:*\n` +
    `  *link* owner@myshop.com Admin@123\n\n` +
    `*📊 After linking — exclusive features:*\n` +
    `  *low stock* — items below reorder level\n` +
    `  *today*     — today's sales summary\n` +
    `  *me*        — your account info\n` +
    `  *logout*    — unlink this number\n\n` +
    `📞 _Contact details & live stock levels are available for registered store users only._\n` +
    footer('Explore stores, products & more on our web app.')
  );
}
