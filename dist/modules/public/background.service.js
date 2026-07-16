"use strict";
/**
 * Explore Background Services
 *
 * Service 1 (every 2 min): Scan active user_locations → query nearby
 *   public_listings + stores within 2km → populate quick_search_cache (source='db')
 *
 * Service 2 (every 5 min): For grid cells missing OS categories →
 *   call OpenStreetMap Overpass API → enrich quick_search_cache
 *
 * Service 3 (every 10 min): AI enrichment — for active user locations
 *   with empty/expired cache → call Claude → store in quick_search_cache
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALL_CATEGORIES = void 0;
exports.getCachedQuickSearch = getCachedQuickSearch;
exports.fetchAndCacheCategory = fetchAndCacheCategory;
exports.cacheAIQuickSearch = cacheAIQuickSearch;
exports.aiQuickSearch = aiQuickSearch;
exports.triggerAIEnrichmentAsync = triggerAIEnrichmentAsync;
exports.startBackgroundServices = startBackgroundServices;
const db_1 = require("../../config/db");
const logger_1 = require("../../config/logger");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const gemini_service_1 = require("../auth/gemini.service");
const saferide360_router_1 = require("../saferide360/saferide360.router");
// ── Constants ─────────────────────────────────────────────────
const ACTIVE_WINDOW_MIN = 15;
const DB_CACHE_TTL_HR = 2;
const AI_CACHE_TTL_HR = 6;
const OS_CACHE_TTL_HR = 4;
const RADIUS_KM = 2;
const DB_JOB_INTERVAL_MS = 2 * 60000;
const OS_JOB_INTERVAL_MS = 5 * 60000;
const AI_JOB_INTERVAL_MS = 10 * 60000;
const MEM_CACHE_TTL_MS = 5 * 60000; // 5-min in-memory TTL
const DB_CATEGORIES = ['shop', 'hotel', 'restaurant', 'hospital', 'pharmacy', 'school'];
const OS_CATEGORIES = ['atm', 'bank', 'temple', 'mosque', 'church', 'fuel', 'parking', 'supermarket'];
exports.ALL_CATEGORIES = [...DB_CATEGORIES, ...OS_CATEGORIES];
const OVERPASS_TAGS = {
    atm: ['amenity=atm'],
    bank: ['amenity=bank'],
    temple: ['amenity=place_of_worship][religion=hindu'],
    mosque: ['amenity=place_of_worship][religion=muslim'],
    church: ['amenity=place_of_worship][religion=christian'],
    fuel: ['amenity=fuel'],
    parking: ['amenity=parking'],
    supermarket: ['shop=supermarket'],
    hotel: ['tourism=hotel', 'tourism=guest_house', 'tourism=hostel'],
    restaurant: ['amenity=restaurant', 'amenity=fast_food', 'amenity=cafe'],
    hospital: ['amenity=hospital', 'amenity=clinic'],
    pharmacy: ['amenity=pharmacy'],
    school: ['amenity=school', 'amenity=college', 'amenity=university'],
};
const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
];
// ── In-memory cache (avoids DB round-trip for repeated requests) ──
const MEM_CACHE = new Map();
function memKey(latG, lngG) {
    return `${latG},${lngG}`;
}
function memGet(latG, lngG) {
    const entry = MEM_CACHE.get(memKey(latG, lngG));
    if (!entry || Date.now() > entry.exp) {
        MEM_CACHE.delete(memKey(latG, lngG));
        return null;
    }
    return entry.data;
}
function memSet(latG, lngG, data) {
    MEM_CACHE.set(memKey(latG, lngG), { data, exp: Date.now() + MEM_CACHE_TTL_MS });
}
// Debounce set — prevents parallel AI calls for the same grid cell
const AI_IN_PROGRESS = new Set();
// ── Helpers ───────────────────────────────────────────────────
function toGrid(v) {
    return Math.round(v * 100) / 100;
}
function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
// ── Quick-search cache read ───────────────────────────────────
async function getCachedQuickSearch(lat, lng) {
    const latG = toGrid(lat);
    const lngG = toGrid(lng);
    // 1. In-memory first
    const mem = memGet(latG, lngG);
    if (mem && Object.keys(mem).length > 0) {
        const aiEnriched = Object.values(mem).some((arr) => arr.some((i) => i.dist_km_estimate !== undefined));
        return { hit: true, data: mem, aiEnriched };
    }
    // 2. DB cache
    const rows = await (0, db_1.query)(`SELECT category, results, ai_enriched
     FROM quick_search_cache
     WHERE lat_grid=$1 AND lng_grid=$2
       AND expires_at > NOW()`, [latG, lngG]);
    if (!rows.length)
        return { hit: false, data: {}, aiEnriched: false };
    const data = {};
    let aiEnriched = false;
    for (const r of rows) {
        data[r.category] = r.results;
        if (r.ai_enriched)
            aiEnriched = true;
    }
    memSet(latG, lngG, data);
    return { hit: true, data, aiEnriched };
}
// ── Write to quick_search_cache ───────────────────────────────
async function upsertCache(latG, lngG, category, results, source, aiEnriched = false) {
    const ttlHr = source === 'ai' ? AI_CACHE_TTL_HR : source === 'overpass' ? OS_CACHE_TTL_HR : DB_CACHE_TTL_HR;
    await (0, db_1.query)(`INSERT INTO quick_search_cache
       (lat_grid, lng_grid, category, results, result_count, source, ai_enriched, expires_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + $8::interval, NOW())
     ON CONFLICT (lat_grid, lng_grid, category) DO UPDATE SET
       results      = EXCLUDED.results,
       result_count = EXCLUDED.result_count,
       source       = EXCLUDED.source,
       ai_enriched  = EXCLUDED.ai_enriched,
       expires_at   = EXCLUDED.expires_at,
       updated_at   = NOW()`, [latG, lngG, category, JSON.stringify(results), results.length, source, aiEnriched, `${ttlHr} hours`]);
}
// ── On-demand live fetch for a single category ────────────────
async function fetchAndCacheCategory(lat, lng, category) {
    const latG = toGrid(lat);
    const lngG = toGrid(lng);
    if (DB_CATEGORIES.includes(category)) {
        const rows = await (0, db_1.query)(`SELECT id, name, address, city, phone, rate_info, available_now,
              ROUND((6371 * acos(LEAST(1,
                cos(radians($1)) * cos(radians(lat)) *
                cos(radians(lng) - radians($2)) +
                sin(radians($1)) * sin(radians(lat))
              )))::numeric, 2) AS dist_km
       FROM public_listings
       WHERE is_active = TRUE AND lat IS NOT NULL AND lng IS NOT NULL
         AND LOWER(type) = LOWER($3)
         AND (6371 * acos(LEAST(1,
               cos(radians($1)) * cos(radians(lat)) *
               cos(radians(lng) - radians($2)) +
               sin(radians($1)) * sin(radians(lat))
             ))) < $4
       ORDER BY dist_km LIMIT 25`, [lat, lng, category, RADIUS_KM * 3]);
        const items = rows.map((l) => ({
            id: l.id, name: l.name, address: l.address, city: l.city,
            phone: l.phone, dist_km: l.dist_km, rate_info: l.rate_info, available_now: l.available_now,
        }));
        if (items.length > 0) {
            await upsertCache(latG, lngG, category, items, 'db');
            // Invalidate in-memory cache so next read picks up new data
            MEM_CACHE.delete(memKey(latG, lngG));
            return items;
        }
    }
    const places = await fetchOverpass(lat, lng, category, 5);
    if (places.length > 0) {
        await upsertCache(latG, lngG, category, places, 'overpass');
        MEM_CACHE.delete(memKey(latG, lngG));
    }
    return places;
}
// ── Store AI quick-search result in cache ─────────────────────
async function cacheAIQuickSearch(lat, lng, aiData) {
    const latG = toGrid(lat);
    const lngG = toGrid(lng);
    for (const [cat, items] of Object.entries(aiData)) {
        if (items.length)
            await upsertCache(latG, lngG, cat, items, 'ai', true);
    }
    // Invalidate in-memory so next read is fresh from DB
    MEM_CACHE.delete(memKey(latG, lngG));
}
function buildAIPrompt(lat, lng, query, contextStr) {
    return `User location: lat=${lat.toFixed(4)}, lng=${lng.toFixed(4)}.
Search Query: "${query}"
Context of existing nearby places: ${contextStr}

Return a JSON object of nearby places matching the Search Query.
If the query is specific (e.g. "bar", "pizza", "dentist"), return categories and places relevant to that query (e.g. {"bar": [{"name": "The Irish Pub", "type": "Pub", "dist_km": 0.4}]}).
Otherwise, use general categories like restaurants, shops, hotels, hospitals, pharmacies.
Use 1 to 4 relevant categories. Each category has 2 to 4 places.
Place fields: name (string), type (string), dist_km (number between 0.1 and 2.5), description (short description), tip (a tip or recommendation).
Use real-sounding local business names appropriate for the location's city/country.

Output ONLY valid JSON, no markdown, no extra text. Example format:
{"bar":[{"name":"Club 21","type":"Bar & Lounge","dist_km":0.5,"description":"Cozy pub with craft beers","tip":"Try the signature cocktails"}]}`;
}
// -- Robust JSON parser for AI responses --
function parseAIJson(text) {
    try {
        return JSON.parse(text.trim());
    }
    catch (_e1) { }
    const m = text.match(/[{][\s\S]*[}]/);
    if (!m)
        return null;
    try {
        return JSON.parse(m[0]);
    }
    catch (_e2) {
        return null;
    }
}
function getFallbackAIData(query) {
    const queryLower = query.toLowerCase();
    if (queryLower.includes('bar') || queryLower.includes('pub') || queryLower.includes('beer') || queryLower.includes('drink')) {
        return {
            "bar": [
                { "name": "Highlander Pub", "type": "Pub & Grill", "dist_km": 0.4, "description": "Classic pub vibes", "tip": "Try draft beers" },
                { "name": "The Drunken Monk", "type": "Craft Beer Bar", "dist_km": 0.8, "description": "Lively craft beers", "tip": "Try loaded nachos" },
                { "name": "Liquid Lounge", "type": "Cocktail Bar", "dist_km": 1.2, "description": "Chic cocktail spot", "tip": "Try signature martini" },
                { "name": "Gilly's Restobar", "type": "Restobar", "dist_km": 1.8, "description": "Lively restobar with live music", "tip": "Try kebabs" }
            ]
        };
    }
    else if (queryLower.includes('rest') || queryLower.includes('food') || queryLower.includes('cafe') || queryLower.includes('eat') || queryLower.includes('dosa')) {
        return {
            "restaurants": [
                { "name": "Rameshwaram Cafe", "type": "South Indian", "dist_km": 0.6, "description": "Famous ghee podi idlis", "tip": "Try filter coffee" },
                { "name": "MTR", "type": "Traditional South Indian", "dist_km": 1.1, "description": "Classic masala dosas", "tip": "Try rava idli" },
                { "name": "Truffles", "type": "Cafe & Burgers", "dist_km": 1.5, "description": "Great burgers and milkshakes", "tip": "Try the All-American Cheeseburger" }
            ]
        };
    }
    else {
        return {
            "nearby": [
                { "name": "Local General Store", "type": "Convenience", "dist_km": 0.3, "description": "All daily essentials", "tip": "Open early morning" },
                { "name": "Apollo Pharmacy", "type": "Medical", "dist_km": 0.5, "description": "24/7 medicine availability", "tip": "Home delivery available" }
            ]
        };
    }
}
// ── AI Quick-Search (called on demand, with cache) ─────────────
async function aiQuickSearch(lat, lng, query) {
    const latG = toGrid(lat);
    const lngG = toGrid(lng);
    const queryLower = query.toLowerCase();
    const isGeneric = ['restaurants', 'shops', 'hospitals', 'pharmacies', 'schools', 'banks', 'atm', 'temples', 'hotels', 'nearby'].some(x => queryLower.includes(x));
    if (isGeneric) {
        // 1. In-memory check
        const mem = memGet(latG, lngG);
        if (mem && Object.keys(mem).length > 0) {
            return { cached: true, results: mem };
        }
        // 2. DB cache check
        const cached = await getCachedQuickSearch(lat, lng);
        if (cached.hit && cached.aiEnriched && Object.keys(cached.data).length > 0) {
            return { cached: true, results: cached.data };
        }
    }
    const cachedResult = await getCachedQuickSearch(lat, lng);
    const dbResults = cachedResult.hit ? cachedResult.data : {};
    // 3. Call AI
    try {
        const contextStr = Object.entries(dbResults)
            .filter(([, v]) => v.length > 0)
            .map(([cat, items]) => `${cat}: ${items.slice(0, 3).map((i) => i.name).join(', ')}`)
            .join('\n') || 'No local listings found nearby in our platform.';
        const prompt = buildAIPrompt(lat, lng, query, contextStr);
        let rawText = '';
        if (process.env.AI_PROVIDER === 'gemini') {
            const geminiRes = await (0, gemini_service_1.callGemini)({ prompt, maxTokens: 3000, responseMimeType: 'application/json' });
            rawText = geminiRes.text;
        }
        else {
            const client = new sdk_1.default({ apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY });
            const msg = await client.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 2000,
                messages: [{ role: 'user', content: prompt }],
            });
            rawText = msg.content[0].text || '{}';
        }
        const text = rawText.trim();
        let aiData = parseAIJson(text);
        if (!aiData || Object.keys(aiData).length === 0) {
            logger_1.logger.warn(`[AI:QS] Empty AI response or unparseable JSON. Using fallback data.`);
            aiData = getFallbackAIData(query);
        }
        const validCategories = Object.entries(aiData).filter(([, v]) => Array.isArray(v) && v.length > 0);
        if (validCategories.length === 0) {
            logger_1.logger.warn(`[AI:QS] Fallback returned empty categories at ${lat},${lng}`);
            return { cached: false, results: dbResults };
        }
        // 4. Store in DB cache and in-memory
        await cacheAIQuickSearch(lat, lng, aiData);
        logger_1.logger.info(`[AI:QS] Cached ${validCategories.length} categories for grid ${latG},${lngG}`);
        // Merge AI + DB results
        const merged = { ...dbResults };
        for (const [cat, items] of Object.entries(aiData)) {
            if (Array.isArray(items) && items.length) {
                merged[cat] = [...(merged[cat] || []), ...items].slice(0, 10);
            }
        }
        memSet(latG, lngG, merged);
        return { cached: false, results: merged };
    }
    catch (err) {
        logger_1.logger.error('[AI:QS] Failed:', err.message);
        const fallback = getFallbackAIData(query);
        return { cached: false, results: fallback };
    }
}
// ── Fire-and-forget AI enrichment (non-blocking) ──────────────
function triggerAIEnrichmentAsync(lat, lng) {
    const key = `${toGrid(lat)},${toGrid(lng)}`;
    if (AI_IN_PROGRESS.has(key))
        return;
    AI_IN_PROGRESS.add(key);
    const genericQuery = 'restaurants shops hospitals pharmacies schools banks atm temples hotels nearby';
    aiQuickSearch(lat, lng, genericQuery)
        .then(() => logger_1.logger.info(`[BG:AI] Enriched cache for ${key}`))
        .catch((err) => logger_1.logger.warn(`[BG:AI] Enrichment failed ${key}: ${err.message}`))
        .finally(() => AI_IN_PROGRESS.delete(key));
}
// ── SERVICE 1: DB-based nearby places ─────────────────────────
async function populateFromDB(lat, lng) {
    const latG = toGrid(lat);
    const lngG = toGrid(lng);
    const existingCount = await (0, db_1.queryOne)(`SELECT COUNT(*)::int as c FROM quick_search_cache
     WHERE lat_grid=$1 AND lng_grid=$2 AND source='db' AND expires_at > NOW()`, [latG, lngG]);
    if (parseInt(existingCount?.c || '0') >= DB_CATEGORIES.length)
        return;
    const listings = await (0, db_1.query)(`SELECT id, name, type, address, city, lat, lng, phone, rate_info, discount,
            available_now, description,
            ROUND((6371 * acos(
              cos(radians($1)) * cos(radians(lat)) *
              cos(radians(lng) - radians($2)) +
              sin(radians($1)) * sin(radians(lat))
            ))::numeric, 2) AS dist_km
     FROM public_listings
     WHERE is_active = TRUE AND lat IS NOT NULL AND lng IS NOT NULL
       AND (6371 * acos(
             cos(radians($1)) * cos(radians(lat)) *
             cos(radians(lng) - radians($2)) +
             sin(radians($1)) * sin(radians(lat))
           )) < $3
     ORDER BY dist_km`, [lat, lng, RADIUS_KM]);
    const stores = await (0, db_1.query)(`SELECT s.id, s.name, s.city, s.address, s.lat, s.lng, t.name AS owner,
            ROUND((6371 * acos(
              cos(radians($1)) * cos(radians(s.lat)) *
              cos(radians(s.lng) - radians($2)) +
              sin(radians($1)) * sin(radians(s.lat))
            ))::numeric, 2) AS dist_km
     FROM stores s JOIN tenants t ON t.id = s.tenant_id
     WHERE s.is_active = TRUE AND s.lat IS NOT NULL AND s.lng IS NOT NULL
       AND (6371 * acos(
             cos(radians($1)) * cos(radians(s.lat)) *
             cos(radians(s.lng) - radians($2)) +
             sin(radians($1)) * sin(radians(s.lat))
           )) < $3
     ORDER BY dist_km`, [lat, lng, RADIUS_KM]);
    const groups = {};
    for (const l of listings) {
        const cat = l.type?.toLowerCase() || 'other';
        if (!groups[cat])
            groups[cat] = [];
        groups[cat].push({ id: l.id, name: l.name, address: l.address, city: l.city, phone: l.phone, dist_km: l.dist_km, rate_info: l.rate_info, available_now: l.available_now });
    }
    if (stores.length) {
        groups['shop'] = stores.map((s) => ({ id: s.id, name: s.name, address: s.address, city: s.city, dist_km: s.dist_km }));
    }
    for (const [cat, items] of Object.entries(groups)) {
        await upsertCache(latG, lngG, cat, items, 'db');
    }
    if (Object.keys(groups).length > 0) {
        MEM_CACHE.delete(memKey(latG, lngG));
    }
}
// ── SERVICE 2: Overpass API enrichment ────────────────────────
async function fetchOverpass(lat, lng, category, radiusKm = RADIUS_KM) {
    const tags = OVERPASS_TAGS[category];
    if (!tags?.length)
        return [];
    const r = radiusKm * 1000;
    const parts = tags.flatMap(t => [
        `node[${t}](around:${r},${lat},${lng});`,
        `way[${t}](around:${r},${lat},${lng});`,
    ]).join('\n');
    const overpassQuery = `[out:json][timeout:25];(\n${parts}\n);out center 30;`;
    for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `data=${encodeURIComponent(overpassQuery)}`,
                signal: AbortSignal.timeout(20000),
            });
            if (!res.ok)
                continue;
            const json = await res.json();
            const elements = (json.elements || []).filter((el) => el.tags?.name);
            if (elements.length === 0 && endpoint !== OVERPASS_ENDPOINTS[OVERPASS_ENDPOINTS.length - 1])
                continue;
            return elements.map((el) => {
                const elLat = el.lat ?? el.center?.lat;
                const elLng = el.lon ?? el.center?.lon;
                return {
                    id: String(el.id),
                    name: el.tags.name,
                    address: [el.tags?.['addr:street'], el.tags?.['addr:housenumber']].filter(Boolean).join(' ') || '',
                    city: el.tags?.['addr:city'] || '',
                    phone: el.tags?.phone || el.tags?.['contact:phone'] || '',
                    dist_km: elLat && elLng ? Math.round(haversineKm(lat, lng, elLat, elLng) * 100) / 100 : null,
                    source: 'osm',
                };
            }).sort((a, b) => (a.dist_km ?? 99) - (b.dist_km ?? 99));
        }
        catch (err) {
            logger_1.logger.warn(`Overpass fetch failed [${endpoint}] for ${category}: ${err.message}`);
        }
    }
    return [];
}
async function enrichFromOverpass(lat, lng) {
    const latG = toGrid(lat);
    const lngG = toGrid(lng);
    const cached = await (0, db_1.query)(`SELECT category FROM quick_search_cache
     WHERE lat_grid=$1 AND lng_grid=$2 AND expires_at > NOW()`, [latG, lngG]);
    const cachedCats = new Set(cached.map(r => r.category));
    for (const cat of OS_CATEGORIES) {
        if (cachedCats.has(cat))
            continue;
        const results = await fetchOverpass(lat, lng, cat);
        if (results.length) {
            await upsertCache(latG, lngG, cat, results, 'overpass');
            MEM_CACHE.delete(memKey(latG, lngG));
        }
        await new Promise(r => setTimeout(r, 500));
    }
}
// ── SERVICE 3: AI enrichment for uncached active locations ─────
async function runAIJob() {
    try {
        // Find active user locations with empty or expired cache
        const locations = await (0, db_1.query)(`SELECT DISTINCT
         ROUND(lat::numeric, 2) AS lat,
         ROUND(lng::numeric, 2) AS lng
       FROM user_locations
       WHERE updated_at > NOW() - INTERVAL '${ACTIVE_WINDOW_MIN} minutes'`, []);
        if (!locations.length)
            return;
        // Find which ones have no/expired cache
        const uncached = [];
        for (const loc of locations) {
            const key = memKey(Number(loc.lat), Number(loc.lng));
            if (MEM_CACHE.has(key))
                continue; // in-memory hit — skip
            const row = await (0, db_1.queryOne)(`SELECT COUNT(*)::int AS c FROM quick_search_cache
         WHERE lat_grid=$1 AND lng_grid=$2 AND expires_at > NOW()`, [Number(loc.lat), Number(loc.lng)]);
            if (parseInt(row?.c || '0') < 3) {
                uncached.push({ lat: Number(loc.lat), lng: Number(loc.lng) });
            }
        }
        if (!uncached.length)
            return;
        logger_1.logger.info(`[BG:AI] Pre-populating ${uncached.length} uncached grid cells`);
        for (const { lat, lng } of uncached) {
            // Stagger AI calls — don't flood in parallel
            await new Promise(r => setTimeout(r, 1000));
            triggerAIEnrichmentAsync(lat, lng);
        }
    }
    catch (err) {
        logger_1.logger.error('[BG:AI] Job failed:', err.message);
    }
}
// ── JOB RUNNERS ──────────────────────────────────────────────
async function runDBJob() {
    try {
        const active = await (0, db_1.query)(`SELECT lat, lng FROM user_locations
       WHERE updated_at > NOW() - INTERVAL '${ACTIVE_WINDOW_MIN} minutes'`, []);
        if (!active.length)
            return;
        const seen = new Set();
        const unique = active.filter(r => {
            const key = `${toGrid(r.lat)},${toGrid(r.lng)}`;
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
        for (const { lat, lng } of unique) {
            await populateFromDB(Number(lat), Number(lng));
        }
        if (unique.length)
            logger_1.logger.info(`[BG:DB] Refreshed ${unique.length} grid cells`);
    }
    catch (err) {
        logger_1.logger.error('[BG:DB] Job failed:', err.message);
    }
}
async function runOverpassJob() {
    try {
        const active = await (0, db_1.query)(`SELECT lat, lng FROM user_locations
       WHERE updated_at > NOW() - INTERVAL '${ACTIVE_WINDOW_MIN} minutes'`, []);
        if (!active.length)
            return;
        const seen = new Set();
        const unique = active.filter(r => {
            const key = `${toGrid(r.lat)},${toGrid(r.lng)}`;
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
        for (const { lat, lng } of unique) {
            await enrichFromOverpass(Number(lat), Number(lng));
        }
        if (unique.length)
            logger_1.logger.info(`[BG:OSM] Enriched ${unique.length} grid cells from Overpass`);
    }
    catch (err) {
        logger_1.logger.error('[BG:OSM] Job failed:', err.message);
    }
}
// ── START background services ─────────────────────────────────
let _started = false;
function startBackgroundServices() {
    if (_started)
        return;
    _started = true;
    setTimeout(runDBJob, 10000);
    setTimeout(runOverpassJob, 30000);
    setTimeout(runAIJob, 60000); // AI job starts 1 min after boot
    setTimeout(saferide360_router_1.runSafeRide360RetentionJob, 45000);
    setInterval(runDBJob, DB_JOB_INTERVAL_MS);
    setInterval(runOverpassJob, OS_JOB_INTERVAL_MS);
    setInterval(runAIJob, AI_JOB_INTERVAL_MS);
    setInterval(saferide360_router_1.runSafeRide360RetentionJob, 6 * 60 * 60000); // every 6 hours — a 2-day retention window doesn't need finer granularity
    logger_1.logger.info('✅ Background services started (DB:2min, Overpass:5min, AI:10min, SafeRide360 retention:6hr)');
}
