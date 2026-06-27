// ============================================================
// PUBLIC SEARCH SERVICE — Guest/Customer store & product search
// ============================================================
import { Router } from 'express';
import { query, queryOne } from '../../config/db';
import rateLimit from 'express-rate-limit';

export const publicSearchRouter = Router();

const phoneRevealLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many phone reveal requests' },
});

function ok(res: any, data: any, meta?: any) {
  res.json({ success: true, data, meta, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg });
}

// ──────────────────────────────────────────────────────────────
// GET /v1/public/stats
// Platform summary counts (stores, products, tenants)
// ──────────────────────────────────────────────────────────────
publicSearchRouter.get('/stats', async (_req, res) => {
  try {
    const [[storeRow], [productRow], [tenantRow], [contributorRow]] = await Promise.all([
      query<any>('SELECT COUNT(*)::int AS count FROM stores s JOIN tenants t ON t.id = s.tenant_id WHERE s.is_active=TRUE AND t.is_active=TRUE'),
      query<any>('SELECT COUNT(*)::int AS count FROM items i JOIN stores s ON s.id = i.store_id JOIN tenants t ON t.id = s.tenant_id WHERE i.is_active=TRUE AND s.is_active=TRUE AND t.is_active=TRUE'),
      query<any>('SELECT COUNT(*)::int AS count FROM tenants WHERE is_active=TRUE'),
      query<any>('SELECT COUNT(*)::int AS count FROM public_listings WHERE is_active=TRUE'),
    ]);
    ok(res, { stores: storeRow?.count||0, products: productRow?.count||0, tenants: tenantRow?.count||0, contributors: contributorRow?.count||0 });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ──────────────────────────────────────────────────────────────
// GET /v1/public/listings/nearby
// Find listings near lat/lng within radius km
// ──────────────────────────────────────────────────────────────
publicSearchRouter.get('/listings/nearby', async (req, res) => {
  try {
    const { lat, lng, radius='15', type='', mode='', limit='30' } = req.query as Record<string,string>;
    if (!lat || !lng) return fail(res, 'lat and lng required');
    const latF = parseFloat(lat); const lngF = parseFloat(lng);
    const radiusKm = Math.min(100, parseFloat(radius)||15);
    const limitNum = Math.min(50, parseInt(limit)||30);

    const conditions = ['is_active=TRUE', 'lat IS NOT NULL', 'lng IS NOT NULL',
      `(6371 * acos(cos(radians(${latF})) * cos(radians(lat)) * cos(radians(lng) - radians(${lngF})) + sin(radians(${latF})) * sin(radians(lat)))) <= ${radiusKm}`
    ];
    const vals: any[] = [];
    let i = 1;
    if (type) { conditions.push(`type = $${i++}`); vals.push(type); }
    if (mode) { conditions.push(`mode = $${i++}`); vals.push(mode); }
    vals.push(limitNum);
    const rows = await query<any>(
      `SELECT id, type, mode, name, phone, city, state, description, rate_info, discount, services, available_now, lat, lng,
              ROUND((6371 * acos(cos(radians(${latF})) * cos(radians(lat)) * cos(radians(lng) - radians(${lngF})) + sin(radians(${latF})) * sin(radians(lat))))::numeric, 2) AS dist_km
       FROM public_listings WHERE ${conditions.join(' AND ')}
       ORDER BY dist_km ASC LIMIT $${i}`, vals
    );
    ok(res, rows, { total: rows.length, lat: latF, lng: lngF, radius: radiusKm });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ──────────────────────────────────────────────────────────────
// GET /v1/public/industries
// Returns all active industries for domain filter
// ──────────────────────────────────────────────────────────────
publicSearchRouter.get('/industries', async (_req, res) => {
  try {
    const industries = await query<any>(
      `SELECT industry_id, display_name, item_noun, default_unit_symbol
       FROM industry_configs
       WHERE is_active = TRUE
       ORDER BY display_name`
    );
    ok(res, industries);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ──────────────────────────────────────────────────────────────
// GET /v1/public/stores
// List all active stores (public directory)
// Query params:
//   search    - text search in store/tenant name, city
//   industry  - filter by industry_id (e.g. pharma, grocery, tea)
//   city      - filter by city
//   state     - filter by state
//   sort      - name_asc | name_desc | city_asc | recent (default: name_asc)
//   page      - page number (default 1)
//   limit     - items per page (default 24)
// ──────────────────────────────────────────────────────────────
publicSearchRouter.get('/stores', async (req, res) => {
  try {
    const {
      search = '',
      industry = '',
      city = '',
      state = '',
      sort = 'name_asc',
      page = '1',
      limit = '24',
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, parseInt(limit) || 24);
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = ['s.is_active = TRUE', 't.is_active = TRUE'];
    const vals: any[] = [];
    let i = 1;

    if (search) {
      conditions.push(`(s.name ILIKE $${i} OR t.name ILIKE $${i} OR s.city ILIKE $${i} OR s.address ILIKE $${i})`);
      vals.push(`%${search}%`);
      i++;
    }

    if (industry) {
      conditions.push(`ic.industry_id = $${i++}`);
      vals.push(industry);
    }

    if (city) {
      conditions.push(`s.city ILIKE $${i++}`);
      vals.push(`%${city}%`);
    }

    if (state) {
      conditions.push(`s.state ILIKE $${i++}`);
      vals.push(`%${state}%`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const sortMap: Record<string, string> = {
      name_asc: 's.name ASC',
      name_desc: 's.name DESC',
      city_asc: 's.city ASC',
      recent: 's.created_at DESC',
    };
    const orderBy = sortMap[sort] || 's.name ASC';

    // Count
    const [countRow] = await query<any>(
      `SELECT COUNT(*)::int as count
       FROM stores s
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN tenant_industries ti ON ti.tenant_id = t.id
       LEFT JOIN industry_configs ic ON ic.id = ti.industry_id
       ${where}`,
      vals
    );

    // Data
    vals.push(limitNum, offset);
    const stores = await query<any>(
      `SELECT
         s.id,
         s.name AS store_name,
         t.name AS company_name,
         t.id   AS tenant_id,
         ic.industry_id,
         ic.display_name AS industry_name,
         -- Mask phone: reveal only last 2 digits
         CASE
           WHEN s.phone IS NOT NULL AND s.phone <> ''
           THEN regexp_replace(s.phone, '.(?=..)', 'X', 'g')
           ELSE NULL
         END AS phone_masked,
         s.phone IS NOT NULL AND s.phone <> '' AS has_phone,
         s.email,
         s.address,
         s.city,
         s.state,
         s.pincode,
         s.owner_name,
         s.created_at,
         -- Google Maps search URL
         CASE
           WHEN s.address IS NOT NULL THEN
             'https://www.google.com/maps/search/' || encode(
               (COALESCE(s.address,'') || ', ' || COALESCE(s.city,'') || ' ' || COALESCE(s.pincode,''))::bytea,
               'escape'
             )
           WHEN s.city IS NOT NULL THEN
             'https://www.google.com/maps/search/' || replace(
               COALESCE(s.city,'') || '+' || COALESCE(s.state,''), ' ', '+'
             )
           ELSE NULL
         END AS maps_url,
         -- Item count (products available)
         (SELECT COUNT(*)::int FROM items it WHERE it.store_id = s.id AND it.is_active = TRUE) AS product_count
       FROM stores s
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN tenant_industries ti ON ti.tenant_id = t.id
       LEFT JOIN industry_configs ic ON ic.id = ti.industry_id
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${i} OFFSET $${i + 1}`,
      vals
    );

    // Fix Google Maps URL properly
    const result = stores.map((s: any) => ({
      ...s,
      maps_url: buildMapsUrl(s.address, s.city, s.state, s.pincode),
    }));

    ok(res, result, {
      total: countRow?.count || 0,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil((countRow?.count || 0) / limitNum),
    });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ──────────────────────────────────────────────────────────────
// GET /v1/public/stores/nearby
// Nearby stores by city or lat/lng approximation
// Query params:
//   city  - city name to match
//   state - optional state filter
//   lat   - latitude (optional, for distance sort)
//   lng   - longitude (optional)
//   industry - filter by industry
//   limit - results limit (default 12)
// ──────────────────────────────────────────────────────────────
publicSearchRouter.get('/stores/nearby', async (req, res) => {
  try {
    const { city = '', state = '', lat, lng, industry = '', limit = '12' } = req.query as Record<string, string>;
    const limitNum = Math.min(50, parseInt(limit) || 12);

    const conditions: string[] = ['s.is_active = TRUE', 't.is_active = TRUE'];
    const vals: any[] = [];
    let i = 1;

    if (city) {
      conditions.push(`s.city ILIKE $${i++}`);
      vals.push(`%${city}%`);
    }
    if (state) {
      conditions.push(`s.state ILIKE $${i++}`);
      vals.push(`%${state}%`);
    }
    if (industry) {
      conditions.push(`ic.industry_id = $${i++}`);
      vals.push(industry);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    // If lat/lng provided and store has lat/lng, sort by distance
    // Otherwise sort by city match quality
    let orderBy = 's.name ASC';
    if (lat && lng) {
      const latF = parseFloat(lat);
      const lngF = parseFloat(lng);
      if (!isNaN(latF) && !isNaN(lngF)) {
        // Use haversine if stores have lat/lng (s.lat, s.lng columns)
        orderBy = `(
          6371 * acos(
            cos(radians(${latF})) * cos(radians(COALESCE(s.lat, 0)))
            * cos(radians(COALESCE(s.lng, 0)) - radians(${lngF}))
            + sin(radians(${latF})) * sin(radians(COALESCE(s.lat, 0)))
          )
        ) ASC NULLS LAST, s.name ASC`;
      }
    }

    vals.push(limitNum);
    const stores = await query<any>(
      `SELECT
         s.id,
         s.name AS store_name,
         t.name AS company_name,
         t.id   AS tenant_id,
         ic.industry_id,
         ic.display_name AS industry_name,
         s.city, s.state, s.pincode, s.address, s.owner_name,
         s.lat, s.lng,
         CASE
           WHEN s.phone IS NOT NULL AND s.phone <> ''
           THEN regexp_replace(s.phone, '.(?=..)', 'X', 'g')
           ELSE NULL
         END AS phone_masked,
         s.phone IS NOT NULL AND s.phone <> '' AS has_phone,
         (SELECT COUNT(*)::int FROM items it WHERE it.store_id = s.id AND it.is_active = TRUE) AS product_count
       FROM stores s
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN tenant_industries ti ON ti.tenant_id = t.id
       LEFT JOIN industry_configs ic ON ic.id = ti.industry_id
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${i}`,
      vals
    );

    const result = stores.map((s: any) => ({
      ...s,
      maps_url: buildMapsUrl(s.address, s.city, s.state, s.pincode),
    }));

    ok(res, result, { total: result.length });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ──────────────────────────────────────────────────────────────
// GET /v1/public/stores/:storeId
// Single store detail (public)
// ──────────────────────────────────────────────────────────────
publicSearchRouter.get('/stores/:storeId', async (req, res) => {
  try {
    const store = await queryOne<any>(
      `SELECT
         s.id,
         s.name AS store_name,
         t.name AS company_name,
         t.id   AS tenant_id,
         ic.industry_id,
         ic.display_name AS industry_name,
         ic.item_noun,
         s.owner_name,
         s.email,
         s.address,
         s.city,
         s.state,
         s.pincode,
         s.lat,
         s.lng,
         CASE
           WHEN s.phone IS NOT NULL AND s.phone <> ''
           THEN regexp_replace(s.phone, '.(?=..)', 'X', 'g')
           ELSE NULL
         END AS phone_masked,
         s.phone IS NOT NULL AND s.phone <> '' AS has_phone,
         s.gst_number,
         s.created_at,
         (SELECT COUNT(*)::int FROM items it WHERE it.store_id = s.id AND it.is_active = TRUE) AS product_count,
         (SELECT json_agg(json_build_object(
           'id', cat.id, 'name', cat.name
         )) FROM categories cat WHERE cat.tenant_id = t.id AND cat.is_active = TRUE) AS categories
       FROM stores s
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN tenant_industries ti ON ti.tenant_id = t.id
       LEFT JOIN industry_configs ic ON ic.id = ti.industry_id
       WHERE s.id = $1 AND s.is_active = TRUE AND t.is_active = TRUE`,
      [req.params.storeId]
    );

    if (!store) return fail(res, 'Store not found', 404);

    ok(res, {
      ...store,
      maps_url: buildMapsUrl(store.address, store.city, store.state, store.pincode),
    });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ──────────────────────────────────────────────────────────────
// POST /v1/public/stores/:storeId/reveal-phone
// Rate-limited phone reveal endpoint
// ──────────────────────────────────────────────────────────────
publicSearchRouter.post('/stores/:storeId/reveal-phone', phoneRevealLimiter, async (req, res) => {
  try {
    const row = await queryOne<any>(
      `SELECT s.phone
       FROM stores s
       JOIN tenants t ON t.id = s.tenant_id
       WHERE s.id = $1 AND s.is_active = TRUE AND t.is_active = TRUE`,
      [req.params.storeId]
    );

    if (!row) return fail(res, 'Store not found', 404);
    if (!row.phone) return fail(res, 'Phone not available', 404);

    ok(res, { phone: row.phone });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ──────────────────────────────────────────────────────────────
// GET /v1/public/stores/:storeId/products
// Public product listing for a store
// ──────────────────────────────────────────────────────────────
publicSearchRouter.get('/stores/:storeId/products', async (req, res) => {
  try {
    const { search = '', category = '', sort = 'name_asc', page = '1', limit = '20' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, parseInt(limit) || 20);
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = ['i.store_id = $1', 'i.is_active = TRUE'];
    const vals: any[] = [req.params.storeId];
    let idx = 2;

    if (search) {
      conditions.push(`(i.name ILIKE $${idx} OR i.brand ILIKE $${idx} OR i.sku ILIKE $${idx})`);
      vals.push(`%${search}%`);
      idx++;
    }
    if (category) {
      conditions.push(`c.name ILIKE $${idx++}`);
      vals.push(`%${category}%`);
    }

    const sortMap: Record<string, string> = {
      name_asc: 'i.name ASC',
      name_desc: 'i.name DESC',
      price_asc: 'i.selling_price ASC NULLS LAST',
      price_desc: 'i.selling_price DESC NULLS LAST',
    };
    const orderBy = sortMap[sort] || 'i.name ASC';
    const where = `WHERE ${conditions.join(' AND ')}`;

    const [countRow] = await query<any>(
      `SELECT COUNT(*)::int as count FROM items i LEFT JOIN categories c ON c.id = i.category_id ${where}`,
      vals
    );

    vals.push(limitNum, offset);
    const products = await query<any>(
      `SELECT
         i.id,
         i.name,
         i.sku,
         i.brand,
         i.batch_number,
         i.description,
         i.selling_price,
         i.mrp,
         i.gst_rate,
         i.current_stock > 0 AS in_stock,
         i.manufacture_date,
         i.expiry_date,
         c.name AS category,
         u.symbol AS unit
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN unit_types u ON u.id = i.primary_unit_id
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      vals
    );

    ok(res, products, {
      total: countRow?.count || 0,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil((countRow?.count || 0) / limitNum),
    });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ──────────────────────────────────────────────────────────────
// GET /v1/public/products
// Global product search across all active stores/tenants
// Query params:
//   search    - text search in product name, brand, SKU, category
//   industry  - filter by industry_id
//   city      - filter by store city
//   in_stock  - "true" to show only in-stock items
//   sort      - name_asc | name_desc | price_asc | price_desc
//   page, limit
// ──────────────────────────────────────────────────────────────
publicSearchRouter.get('/products', async (req, res) => {
  try {
    const {
      search = '', industry = '', city = '',
      in_stock = '', sort = 'name_asc',
      page = '1', limit = '30',
    } = req.query as Record<string, string>;

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, parseInt(limit) || 30);
    const offset   = (pageNum - 1) * limitNum;

    const conditions: string[] = [
      'i.is_active = TRUE',
      's.is_active = TRUE',
      't.is_active = TRUE',
    ];
    const vals: any[] = [];
    let idx = 1;

    if (search) {
      conditions.push(`(i.name ILIKE $${idx} OR i.brand ILIKE $${idx} OR i.sku ILIKE $${idx} OR c.name ILIKE $${idx})`);
      vals.push(`%${search}%`); idx++;
    }
    if (industry) {
      conditions.push(`ic.industry_id = $${idx++}`);
      vals.push(industry);
    }
    if (city) {
      conditions.push(`s.city ILIKE $${idx++}`);
      vals.push(`%${city}%`);
    }
    if (in_stock === 'true') {
      conditions.push('i.current_stock > 0');
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const sortMap: Record<string, string> = {
      name_asc:   'i.name ASC',
      name_desc:  'i.name DESC',
      price_asc:  'i.selling_price ASC NULLS LAST',
      price_desc: 'i.selling_price DESC NULLS LAST',
    };
    const orderBy = sortMap[sort] || 'i.name ASC';

    const [countRow] = await query<any>(
      `SELECT COUNT(*)::int AS count
       FROM items i
       JOIN stores s ON s.id = i.store_id
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN tenant_industries ti ON ti.tenant_id = t.id
       LEFT JOIN industry_configs ic ON ic.id = ti.industry_id
       ${where}`,
      vals
    );

    vals.push(limitNum, offset);
    const products = await query<any>(
      `SELECT
         i.id,
         i.name,
         i.sku,
         i.brand,
         i.batch_number,
         i.selling_price,
         i.mrp,
         i.current_stock > 0 AS in_stock,
         i.manufacture_date,
         i.expiry_date,
         c.name  AS category,
         u.symbol AS unit,
         s.id    AS store_id,
         s.name  AS store_name,
         s.city  AS store_city,
         s.state AS store_state,
         ic.industry_id,
         ic.display_name AS industry_name
       FROM items i
       JOIN stores s ON s.id = i.store_id
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN unit_types u ON u.id = i.primary_unit_id
       LEFT JOIN tenant_industries ti ON ti.tenant_id = t.id
       LEFT JOIN industry_configs ic ON ic.id = ti.industry_id
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      vals
    );

    ok(res, products, {
      total: countRow?.count || 0,
      page:  pageNum,
      limit: limitNum,
      pages: Math.ceil((countRow?.count || 0) / limitNum),
    });
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ──────────────────────────────────────────────────────────────
// GET /v1/public/cities
// Distinct cities for nearby search dropdown
// ──────────────────────────────────────────────────────────────
publicSearchRouter.get('/cities', async (_req, res) => {
  try {
    const cities = await query<any>(
      `SELECT DISTINCT s.city, s.state
       FROM stores s
       JOIN tenants t ON t.id = s.tenant_id
       WHERE s.city IS NOT NULL AND s.city <> ''
         AND s.is_active = TRUE AND t.is_active = TRUE
       ORDER BY s.city`
    );
    ok(res, cities);
  } catch (e: any) {
    fail(res, e.message, 500);
  }
});

// ──────────────────────────────────────────────────────────────
// GET /v1/public/listings
// Search hospitality + driver listings
// type: hotel|restaurant|paying_guest|resort|driver_auto|driver_car|driver_traveller
// ──────────────────────────────────────────────────────────────
const listingCreateLimiter = rateLimit({ windowMs: 60*1000, max: 5, message: { success:false, error:'Too many submissions' } });

publicSearchRouter.get('/listings', async (req, res) => {
  try {
    const { type='', city='', search='', available='', page='1', limit='20' } = req.query as Record<string,string>;
    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, parseInt(limit) || 20);
    const offset   = (pageNum - 1) * limitNum;

    const conditions: string[] = ['is_active = TRUE'];
    const vals: any[] = [];
    let i = 1;

    if (type)   { conditions.push(`type = $${i++}`);             vals.push(type); }
    if (city)   { conditions.push(`city ILIKE $${i++}`);         vals.push(`%${city}%`); }
    if (search) { conditions.push(`(name ILIKE $${i} OR description ILIKE $${i} OR rate_info ILIKE $${i})`); vals.push(`%${search}%`); i++; }
    if (available === 'true') { conditions.push('available_now = TRUE'); }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const [countRow] = await query<any>(`SELECT COUNT(*)::int AS count FROM public_listings ${where}`, vals);

    vals.push(limitNum, offset);
    const rows = await query<any>(
      `SELECT id, type, name, phone, city, state, address, description,
              rate_info, discount, services, available_now, availability, created_at
       FROM public_listings
       ${where}
       ORDER BY available_now DESC, created_at DESC
       LIMIT $${i} OFFSET $${i+1}`,
      vals
    );

    ok(res, rows, { total: countRow?.count||0, page: pageNum, limit: limitNum, pages: Math.ceil((countRow?.count||0)/limitNum) });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ──────────────────────────────────────────────────────────────
// POST /v1/public/listings
// Quick-onboard a seller or driver (rate-limited, no auth)
// ──────────────────────────────────────────────────────────────
publicSearchRouter.post('/listings', listingCreateLimiter, async (req, res) => {
  try {
    const { type, mode='provider', name, phone, city, state, address, description, rate_info, discount, services, available_now, availability, lat, lng } = req.body;
    if (!type?.trim()) return fail(res, 'type is required');
    if (!name?.trim()) return fail(res, 'name is required');
    if (!phone?.trim()) return fail(res, 'phone is required');
    const validModes = ['provider','seeker'];
    const safeMode = validModes.includes(mode) ? mode : 'provider';

    const [row] = await query<any>(
      `INSERT INTO public_listings (type,mode,name,phone,city,state,address,description,rate_info,discount,services,available_now,availability,lat,lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15)
       RETURNING id, type, mode, name, city, available_now`,
      [type.trim(), safeMode, name.trim(), phone.trim(), city||null, state||null, address||null, description||null,
       rate_info||null, discount||null, JSON.stringify(services||[]), available_now!==false,
       JSON.stringify(availability||{}), lat?parseFloat(lat):null, lng?parseFloat(lng):null]
    );
    ok(res, row);
  } catch (e: any) { fail(res, e.message, 500); }
});

// ──────────────────────────────────────────────────────────────
// POST /v1/public/sessions
// Log a guest /explore session (no auth — rate-limited)
// Body: { guest_id, guest_name }
// ──────────────────────────────────────────────────────────────
const sessionLimiter = rateLimit({ windowMs: 60*1000, max: 20, message: { success:false, error:'Too many requests' } });

publicSearchRouter.post('/sessions', sessionLimiter, async (req, res) => {
  try {
    const { guest_id, guest_name } = req.body;
    if (!guest_id?.trim()) return fail(res, 'guest_id is required');
    const gid = guest_id.trim().substring(0, 50);
    const gname = (guest_name || 'Guest').substring(0, 200);

    // Upsert daily session (unique per guest+date)
    await query(
      `INSERT INTO explore_sessions (guest_id, guest_name, session_date)
       VALUES ($1, $2, CURRENT_DATE)
       ON CONFLICT (guest_id, session_date) DO NOTHING`,
      [gid, gname]
    );

    // Upsert guest aggregate record and get is_active status
    const [guestRow] = await query<any>(
      `INSERT INTO explore_guests (guest_id, guest_name, first_seen, last_seen, total_sessions)
       VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE, 1)
       ON CONFLICT (guest_id) DO UPDATE SET
         guest_name = EXCLUDED.guest_name,
         last_seen = CURRENT_DATE,
         total_sessions = explore_guests.total_sessions + 1,
         updated_at = NOW()
       RETURNING is_active`,
      [gid, gname]
    );

    ok(res, { tracked: true, is_active: guestRow?.is_active !== false });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ──────────────────────────────────────────────────────────────
// POST /v1/public/sessions/contribution
// Increment listing_count when guest adds a listing
// Body: { guest_id }
// ──────────────────────────────────────────────────────────────
publicSearchRouter.post('/sessions/contribution', sessionLimiter, async (req, res) => {
  try {
    const { guest_id } = req.body;
    if (!guest_id?.trim()) return fail(res, 'guest_id is required');
    await query(
      `UPDATE explore_guests SET listing_count = listing_count + 1, updated_at = NOW()
       WHERE guest_id = $1`,
      [guest_id.trim().substring(0, 50)]
    );
    ok(res, { recorded: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ──────────────────────────────────────────────────────────────
// POST /v1/public/location
// Upsert active user lat/lng for background quick-search pre-caching
// Body: { guest_id, lat, lng, accuracy?, city? }
// ──────────────────────────────────────────────────────────────
const locationLimiter = rateLimit({ windowMs: 60*1000, max: 30, message: { success:false, error:'Too many location updates' } });

publicSearchRouter.post('/location', locationLimiter, async (req, res) => {
  try {
    const { guest_id, lat, lng, accuracy, city } = req.body;
    if (!guest_id?.trim()) return fail(res, 'guest_id is required');
    const latF = parseFloat(lat);
    const lngF = parseFloat(lng);
    if (isNaN(latF) || isNaN(lngF)) return fail(res, 'lat and lng must be valid numbers');
    if (latF < -90 || latF > 90 || lngF < -180 || lngF > 180) return fail(res, 'lat/lng out of range');

    await query(
      `INSERT INTO user_locations (guest_id, lat, lng, accuracy, city, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (guest_id) DO UPDATE SET
         lat = EXCLUDED.lat, lng = EXCLUDED.lng,
         accuracy = EXCLUDED.accuracy, city = EXCLUDED.city,
         updated_at = NOW()`,
      [guest_id.trim().substring(0, 50), latF, lngF, accuracy ? parseFloat(accuracy) : null, city || null]
    );
    ok(res, { tracked: true });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ──────────────────────────────────────────────────────────────
// GET /v1/public/quicksearch
// Return cached nearby places grouped by category
// Query params: lat, lng, category? (optional filter), ai? (true to trigger AI)
// ──────────────────────────────────────────────────────────────
publicSearchRouter.get('/quicksearch', async (req, res) => {
  try {
    const { lat, lng, category = '', ai = 'false', q = '' } = req.query as Record<string, string>;
    if (!lat || !lng) return fail(res, 'lat and lng required');
    const latF = parseFloat(lat);
    const lngF = parseFloat(lng);
    if (isNaN(latF) || isNaN(lngF)) return fail(res, 'Invalid coordinates');

    // Import on first use (avoids circular at module load time)
    const { getCachedQuickSearch, aiQuickSearch } = await import('./background.service');

    if (ai === 'true' && q.trim()) {
      const { cached, results } = await aiQuickSearch(latF, lngF, q.trim());
      const filtered = category ? { [category]: results[category] || [] } : results;
      return ok(res, filtered, { source: cached ? 'cache' : 'ai', lat: latF, lng: lngF });
    }

    const { hit, data } = await getCachedQuickSearch(latF, lngF);
    const filtered = category ? { [category]: data[category] || [] } : data;
    return ok(res, filtered, { source: hit ? 'cache' : 'miss', lat: latF, lng: lngF });
  } catch (e: any) { fail(res, e.message, 500); }
});

// ──────────────────────────────────────────────────────────────
// Helper: Build Google Maps URL
// ──────────────────────────────────────────────────────────────
function buildMapsUrl(address?: string, city?: string, state?: string, pincode?: string): string | null {
  const parts: string[] = [];
  if (address) parts.push(address.trim());
  if (city) parts.push(city.trim());
  if (state) parts.push(state.trim());
  if (pincode) parts.push(pincode.trim());

  if (parts.length === 0) return null;

  const q = encodeURIComponent(parts.join(', '));
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}
