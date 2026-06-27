/**
 * Explore Background Services
 *
 * Service 1 (every 2 min): Scan active user_locations → query nearby
 *   public_listings + stores within 2km → populate quick_search_cache (source='db')
 *
 * Service 2 (every 5 min): For grid cells missing OS categories (temple, atm,
 *   bank, etc.) → call OpenStreetMap Overpass API → enrich quick_search_cache
 *
 * Service 3 (on-demand): AI quick-search — check cache before calling AI;
 *   store AI result back in cache. Called from search.service.ts.
 */

import { query as dbQuery, queryOne } from '../../config/db';
import { logger } from '../../config/logger';
import Anthropic from '@anthropic-ai/sdk';

// ── Constants ─────────────────────────────────────────────────
const ACTIVE_WINDOW_MIN  = 15;          // consider user active if seen < 15 min ago
const DB_CACHE_TTL_HR    = 2;           // DB-sourced cache valid for 2h
const AI_CACHE_TTL_HR    = 6;           // AI-sourced cache valid for 6h
const RADIUS_KM          = 2;
const DB_JOB_INTERVAL_MS = 2 * 60_000; // run every 2 min
const OS_JOB_INTERVAL_MS = 5 * 60_000; // run every 5 min

// Categories sourced from our own DB (public_listings types + stores)
const DB_CATEGORIES = ['shop', 'hotel', 'restaurant', 'hospital', 'pharmacy', 'school'];
// Categories enriched via Overpass API (OSM)
const OS_CATEGORIES  = ['atm', 'bank', 'temple', 'mosque', 'church', 'fuel', 'parking', 'supermarket'];
// All combined for the quick-search API response
export const ALL_CATEGORIES = [...DB_CATEGORIES, ...OS_CATEGORIES];

// Overpass tag mapping — arrays allow multi-tag union queries (no regex, max compatibility)
const OVERPASS_TAGS: Record<string, string[]> = {
  atm:         ['amenity=atm'],
  bank:        ['amenity=bank'],
  temple:      ['amenity=place_of_worship][religion=hindu'],
  mosque:      ['amenity=place_of_worship][religion=muslim'],
  church:      ['amenity=place_of_worship][religion=christian'],
  fuel:        ['amenity=fuel'],
  parking:     ['amenity=parking'],
  supermarket: ['shop=supermarket'],
  // DB category fallbacks via OSM (simple equality tags for max server compatibility)
  hotel:       ['tourism=hotel', 'tourism=guest_house', 'tourism=hostel'],
  restaurant:  ['amenity=restaurant', 'amenity=fast_food', 'amenity=cafe'],
  hospital:    ['amenity=hospital', 'amenity=clinic'],
  pharmacy:    ['amenity=pharmacy'],
  school:      ['amenity=school', 'amenity=college', 'amenity=university'],
};
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// ── Helpers ───────────────────────────────────────────────────
function toGrid(v: number): number {
  return Math.round(v * 100) / 100; // 2 decimal places ≈ 1.1 km grid
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Quick-search cache read (used by search.service.ts) ───────
export async function getCachedQuickSearch(lat: number, lng: number): Promise<{
  hit: boolean;
  data: Record<string, any[]>;
  aiEnriched: boolean;
}> {
  const latG = toGrid(lat);
  const lngG = toGrid(lng);

  const rows = await dbQuery<any>(
    `SELECT category, results, ai_enriched
     FROM quick_search_cache
     WHERE lat_grid=$1 AND lng_grid=$2
       AND expires_at > NOW()`,
    [latG, lngG]
  );

  if (!rows.length) return { hit: false, data: {}, aiEnriched: false };

  const data: Record<string, any[]> = {};
  let aiEnriched = false;
  for (const r of rows) {
    data[r.category] = r.results;
    if (r.ai_enriched) aiEnriched = true;
  }
  return { hit: true, data, aiEnriched };
}

// ── Write to quick_search_cache ───────────────────────────────
async function upsertCache(
  latG: number, lngG: number, category: string,
  results: any[], source: 'db' | 'overpass' | 'ai', aiEnriched = false
) {
  const ttlHr = source === 'ai' ? AI_CACHE_TTL_HR : DB_CACHE_TTL_HR;
  await dbQuery(
    `INSERT INTO quick_search_cache
       (lat_grid, lng_grid, category, results, result_count, source, ai_enriched, expires_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + $8::interval, NOW())
     ON CONFLICT (lat_grid, lng_grid, category) DO UPDATE SET
       results      = EXCLUDED.results,
       result_count = EXCLUDED.result_count,
       source       = EXCLUDED.source,
       ai_enriched  = EXCLUDED.ai_enriched,
       expires_at   = EXCLUDED.expires_at,
       updated_at   = NOW()`,
    [latG, lngG, category, JSON.stringify(results), results.length, source, aiEnriched, `${ttlHr} hours`]
  );
}

// ── On-demand live fetch for a single category (called from quicksearch on cache miss) ──
export async function fetchAndCacheCategory(lat: number, lng: number, category: string): Promise<any[]> {
  const latG = toGrid(lat);
  const lngG = toGrid(lng);

  if (DB_CATEGORIES.includes(category)) {
    // Query our own public_listings table
    const rows = await dbQuery<any>(
      `SELECT id, name, address, city, phone, rate_info, available_now,
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
       ORDER BY dist_km LIMIT 25`,
      [lat, lng, category, RADIUS_KM * 3]  // 3× radius for on-demand fetch
    );
    const items = rows.map((l: any) => ({
      id: l.id, name: l.name, address: l.address, city: l.city,
      phone: l.phone, dist_km: l.dist_km, rate_info: l.rate_info, available_now: l.available_now,
    }));
    if (items.length > 0) {
      await upsertCache(latG, lngG, category, items, 'db');
      return items;
    }
    // DB has no data for this location → fall back to Overpass (e.g. hotels/restaurants in OSM)
  }

  // OSM category via Overpass — runs on server, no browser CORS issues
  // Use 5km radius for on-demand searches so users actually find results
  const places = await fetchOverpass(lat, lng, category, 5);
  if (places.length > 0) await upsertCache(latG, lngG, category, places, 'overpass');
  return places;
}

// ── Store AI quick-search result in cache ─────────────────────
export async function cacheAIQuickSearch(lat: number, lng: number, aiData: Record<string, any[]>) {
  const latG = toGrid(lat);
  const lngG = toGrid(lng);
  for (const [cat, items] of Object.entries(aiData)) {
    if (items.length) await upsertCache(latG, lngG, cat, items, 'ai', true);
  }
}

// ── SERVICE 1: DB-based nearby places ─────────────────────────
async function populateFromDB(lat: number, lng: number) {
  const latG = toGrid(lat);
  const lngG = toGrid(lng);

  // Skip if all DB categories already cached and fresh
  const existingCount = await queryOne<{ c: string }>(
    `SELECT COUNT(*)::int as c FROM quick_search_cache
     WHERE lat_grid=$1 AND lng_grid=$2 AND source='db' AND expires_at > NOW()`,
    [latG, lngG]
  );
  if (parseInt((existingCount as any)?.c || '0') >= DB_CATEGORIES.length) return;

  // Query nearby public_listings grouped by type
  const listings = await dbQuery<any>(
    `SELECT id, name, type, address, city, lat, lng, phone, rate_info, discount,
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
     ORDER BY dist_km`,
    [lat, lng, RADIUS_KM]
  );

  // Query nearby stores as 'shop' category
  const stores = await dbQuery<any>(
    `SELECT s.id, s.name, s.city, s.address, s.lat, s.lng, t.name AS owner,
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
     ORDER BY dist_km`,
    [lat, lng, RADIUS_KM]
  );

  // Group listings by type
  const groups: Record<string, any[]> = {};
  for (const l of listings) {
    const cat = l.type?.toLowerCase() || 'other';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({ id: l.id, name: l.name, address: l.address, city: l.city, phone: l.phone, dist_km: l.dist_km, rate_info: l.rate_info, available_now: l.available_now });
  }
  if (stores.length) {
    groups['shop'] = stores.map(s => ({ id: s.id, name: s.name, address: s.address, city: s.city, dist_km: s.dist_km }));
  }

  // Upsert each category
  for (const [cat, items] of Object.entries(groups)) {
    await upsertCache(latG, lngG, cat, items, 'db');
  }
}

// ── SERVICE 2: Overpass API enrichment ────────────────────────
async function fetchOverpass(lat: number, lng: number, category: string, radiusKm = RADIUS_KM): Promise<any[]> {
  const tags = OVERPASS_TAGS[category];
  if (!tags?.length) return [];

  const r = radiusKm * 1000;
  const parts = tags.flatMap(t => [
    `node[${t}](around:${r},${lat},${lng});`,
    `way[${t}](around:${r},${lat},${lng});`,
  ]).join('\n');
  const query = `[out:json][timeout:25];(\n${parts}\n);out center 30;`;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const json: any = await res.json();
      const elements = (json.elements || []).filter((el: any) => el.tags?.name);
      if (elements.length === 0 && endpoint !== OVERPASS_ENDPOINTS[OVERPASS_ENDPOINTS.length - 1]) continue;
      return elements.map((el: any) => {
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
      }).sort((a: any, b: any) => (a.dist_km ?? 99) - (b.dist_km ?? 99));
    } catch (err: any) {
      logger.warn(`Overpass fetch failed [${endpoint}] for ${category}: ${err.message}`);
    }
  }
  return [];
}

async function enrichFromOverpass(lat: number, lng: number) {
  const latG = toGrid(lat);
  const lngG = toGrid(lng);

  // Only enrich categories not yet cached
  const cached = await dbQuery<{ category: string }>(
    `SELECT category FROM quick_search_cache
     WHERE lat_grid=$1 AND lng_grid=$2 AND expires_at > NOW()`,
    [latG, lngG]
  );
  const cachedCats = new Set(cached.map(r => r.category));

  for (const cat of OS_CATEGORIES) {
    if (cachedCats.has(cat)) continue;
    const results = await fetchOverpass(lat, lng, cat);
    if (results.length) await upsertCache(latG, lngG, cat, results, 'overpass');
    // Small delay between Overpass calls to be polite
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── AI Quick-Search (called on demand, with cache) ─────────────
export async function aiQuickSearch(lat: number, lng: number, query: string): Promise<{
  cached: boolean;
  results: Record<string, any[]>;
}> {
  // 1. Check cache first
  const cached = await getCachedQuickSearch(lat, lng);
  if (cached.hit && cached.aiEnriched) {
    return { cached: true, results: cached.data };
  }

  // 2. Get DB results for context
  const dbResults = cached.hit ? cached.data : {};

  // 3. Call Claude AI
  try {
    const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY });
    const contextStr = Object.entries(dbResults)
      .filter(([, v]) => v.length > 0)
      .map(([cat, items]) => `${cat}: ${items.slice(0, 3).map((i: any) => i.name).join(', ')}`)
      .join('\n') || 'No local listings found nearby.';

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are a local area assistant. The user is at lat=${lat.toFixed(4)}, lng=${lng.toFixed(4)}.
Known nearby places from our database:
${contextStr}

User query: "${query}"

Return a JSON object with categories as keys and arrays of place objects as values.
Each place: { name, type, description, dist_km_estimate, tip }
Categories to include if relevant: shop, hotel, restaurant, hospital, pharmacy, atm, bank, temple, fuel.
Only include categories with 1+ results. Keep each category to max 5 items.
Return ONLY valid JSON, no markdown.`,
      }],
    });

    const text = (msg.content[0] as any).text?.trim() || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`AI returned no JSON. Raw: ${text.slice(0, 200)}`);
    const aiData: Record<string, any[]> = JSON.parse(jsonMatch[0]);

    // 4. Cache AI result
    await cacheAIQuickSearch(lat, lng, aiData);

    // Merge with DB data
    const merged: Record<string, any[]> = { ...dbResults };
    for (const [cat, items] of Object.entries(aiData)) {
      merged[cat] = [...(merged[cat] || []), ...items].slice(0, 10);
    }

    return { cached: false, results: merged };
  } catch (err: any) {
    logger.error('AI quick-search failed:', err.message);
    return { cached: false, results: dbResults };
  }
}

// ── JOB RUNNERS ──────────────────────────────────────────────
async function runDBJob() {
  try {
    const active = await dbQuery<{ lat: number; lng: number }>(
      `SELECT lat, lng FROM user_locations
       WHERE updated_at > NOW() - INTERVAL '${ACTIVE_WINDOW_MIN} minutes'`,
      []
    );
    if (!active.length) return;

    // Deduplicate by grid cell
    const seen = new Set<string>();
    const unique = active.filter(r => {
      const key = `${toGrid(r.lat)},${toGrid(r.lng)}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });

    for (const { lat, lng } of unique) {
      await populateFromDB(Number(lat), Number(lng));
    }
    if (unique.length) logger.info(`[BG:DB] Refreshed ${unique.length} grid cells`);
  } catch (err: any) {
    logger.error('[BG:DB] Job failed:', err.message);
  }
}

async function runOverpassJob() {
  try {
    const active = await dbQuery<{ lat: number; lng: number }>(
      `SELECT lat, lng FROM user_locations
       WHERE updated_at > NOW() - INTERVAL '${ACTIVE_WINDOW_MIN} minutes'`,
      []
    );
    if (!active.length) return;

    const seen = new Set<string>();
    const unique = active.filter(r => {
      const key = `${toGrid(r.lat)},${toGrid(r.lng)}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });

    for (const { lat, lng } of unique) {
      await enrichFromOverpass(Number(lat), Number(lng));
    }
    if (unique.length) logger.info(`[BG:OSM] Enriched ${unique.length} grid cells from Overpass`);
  } catch (err: any) {
    logger.error('[BG:OSM] Job failed:', err.message);
  }
}

// ── START background services ─────────────────────────────────
let _started = false;
export function startBackgroundServices() {
  if (_started) return;
  _started = true;

  // Run once immediately after startup (with a small delay)
  setTimeout(runDBJob, 10_000);
  setTimeout(runOverpassJob, 30_000);

  // Then on schedule
  setInterval(runDBJob,      DB_JOB_INTERVAL_MS);
  setInterval(runOverpassJob, OS_JOB_INTERVAL_MS);

  logger.info('✅ Background services started (DB:2min, Overpass:5min)');
}
