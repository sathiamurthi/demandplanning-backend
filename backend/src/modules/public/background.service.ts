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

import { query as dbQuery, queryOne } from '../../config/db';
import { logger } from '../../config/logger';
import Anthropic from '@anthropic-ai/sdk';
import { callGemini } from '../auth/gemini.service';

// ── Constants ─────────────────────────────────────────────────
const ACTIVE_WINDOW_MIN  = 15;
const DB_CACHE_TTL_HR    = 2;
const AI_CACHE_TTL_HR    = 6;
const OS_CACHE_TTL_HR    = 4;
const RADIUS_KM          = 2;
const DB_JOB_INTERVAL_MS = 2  * 60_000;
const OS_JOB_INTERVAL_MS = 5  * 60_000;
const AI_JOB_INTERVAL_MS = 10 * 60_000;
const MEM_CACHE_TTL_MS   = 5  * 60_000; // 5-min in-memory TTL

const DB_CATEGORIES = ['shop', 'hotel', 'restaurant', 'hospital', 'pharmacy', 'school'];
const OS_CATEGORIES  = ['atm', 'bank', 'temple', 'mosque', 'church', 'fuel', 'parking', 'supermarket'];
export const ALL_CATEGORIES = [...DB_CATEGORIES, ...OS_CATEGORIES];

const OVERPASS_TAGS: Record<string, string[]> = {
  atm:         ['amenity=atm'],
  bank:        ['amenity=bank'],
  temple:      ['amenity=place_of_worship][religion=hindu'],
  mosque:      ['amenity=place_of_worship][religion=muslim'],
  church:      ['amenity=place_of_worship][religion=christian'],
  fuel:        ['amenity=fuel'],
  parking:     ['amenity=parking'],
  supermarket: ['shop=supermarket'],
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

// ── In-memory cache (avoids DB round-trip for repeated requests) ──
const MEM_CACHE = new Map<string, { data: Record<string, any[]>; exp: number }>();

function memKey(latG: number, lngG: number): string {
  return `${latG},${lngG}`;
}
function memGet(latG: number, lngG: number): Record<string, any[]> | null {
  const entry = MEM_CACHE.get(memKey(latG, lngG));
  if (!entry || Date.now() > entry.exp) { MEM_CACHE.delete(memKey(latG, lngG)); return null; }
  return entry.data;
}
function memSet(latG: number, lngG: number, data: Record<string, any[]>) {
  MEM_CACHE.set(memKey(latG, lngG), { data, exp: Date.now() + MEM_CACHE_TTL_MS });
}

// Debounce set — prevents parallel AI calls for the same grid cell
const AI_IN_PROGRESS = new Set<string>();

// ── Helpers ───────────────────────────────────────────────────
function toGrid(v: number): number {
  return Math.round(v * 100) / 100;
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

// ── Quick-search cache read ───────────────────────────────────
export async function getCachedQuickSearch(lat: number, lng: number): Promise<{
  hit: boolean;
  data: Record<string, any[]>;
  aiEnriched: boolean;
}> {
  const latG = toGrid(lat);
  const lngG = toGrid(lng);

  // 1. In-memory first
  const mem = memGet(latG, lngG);
  if (mem && Object.keys(mem).length > 0) {
    const aiEnriched = Object.values(mem).some((arr: any[]) =>
      arr.some((i: any) => i.dist_km_estimate !== undefined)
    );
    return { hit: true, data: mem, aiEnriched };
  }

  // 2. DB cache
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
  memSet(latG, lngG, data);
  return { hit: true, data, aiEnriched };
}

// ── Write to quick_search_cache ───────────────────────────────
async function upsertCache(
  latG: number, lngG: number, category: string,
  results: any[], source: 'db' | 'overpass' | 'ai', aiEnriched = false
) {
  const ttlHr = source === 'ai' ? AI_CACHE_TTL_HR : source === 'overpass' ? OS_CACHE_TTL_HR : DB_CACHE_TTL_HR;
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

// ── On-demand live fetch for a single category ────────────────
export async function fetchAndCacheCategory(lat: number, lng: number, category: string): Promise<any[]> {
  const latG = toGrid(lat);
  const lngG = toGrid(lng);

  if (DB_CATEGORIES.includes(category)) {
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
      [lat, lng, category, RADIUS_KM * 3]
    );
    const items = rows.map((l: any) => ({
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
export async function cacheAIQuickSearch(lat: number, lng: number, aiData: Record<string, any[]>) {
  const latG = toGrid(lat);
  const lngG = toGrid(lng);
  for (const [cat, items] of Object.entries(aiData)) {
    if (items.length) await upsertCache(latG, lngG, cat, items, 'ai', true);
  }
  // Invalidate in-memory so next read is fresh from DB
  MEM_CACHE.delete(memKey(latG, lngG));
}

// ── Build AI prompt with location context ─────────────────────
function buildAIPrompt(lat: number, lng: number, query: string, contextStr: string): string {
  return `You are a local area assistant for India. The user is at coordinates lat=${lat.toFixed(4)}, lng=${lng.toFixed(4)}.

Known nearby places from our platform:
${contextStr}

User query: "${query}"

Based on these coordinates (which are in India), generate a realistic JSON response of nearby places.
Identify the likely Indian city/area from the coordinates and create plausible place names for that area.

Return ONLY a valid JSON object (no markdown, no code fences, no explanation).
Keys should be category names, values should be arrays of place objects.
Each place object: { "name": string, "type": string, "description": string, "dist_km_estimate": number, "tip": string }

Categories to include (only if relevant to the query, minimum 4 categories):
restaurant, hospital, pharmacy, school, atm, bank, hotel, shop, temple, fuel

Rules:
- Generate 3-5 realistic places per category
- Use authentic Indian business names (e.g. "Sri Venkateswara Medical Stores", "Hotel Saravana Bhavan")
- dist_km_estimate should be between 0.1 and 2.5
- Make descriptions specific and helpful
- Always return at least the categories: restaurant, shop, pharmacy, atm

Return ONLY the JSON object.`;
}

// ── AI Quick-Search (called on demand, with cache) ─────────────
export async function aiQuickSearch(lat: number, lng: number, query: string): Promise<{
  cached: boolean;
  results: Record<string, any[]>;
}> {
  const latG = toGrid(lat);
  const lngG = toGrid(lng);

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

  const dbResults = cached.hit ? cached.data : {};

  // 3. Call AI
  try {
    const contextStr = Object.entries(dbResults)
      .filter(([, v]) => v.length > 0)
      .map(([cat, items]) => `${cat}: ${items.slice(0, 3).map((i: any) => i.name).join(', ')}`)
      .join('\n') || 'No local listings found nearby in our platform.';

    const prompt = buildAIPrompt(lat, lng, query, contextStr);
    let rawText = '';

    if (process.env.AI_PROVIDER === 'gemini') {
      const geminiRes = await callGemini({ prompt, maxTokens: 1200, responseMimeType: 'application/json' });
      rawText = geminiRes.text;
    } else {
      const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY });
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      });
      rawText = (msg.content[0] as any).text || '{}';
    }

    const text = rawText.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(`[AI:QS] No JSON in response. Raw: ${text.slice(0, 300)}`);
      return { cached: false, results: dbResults };
    }

    const aiData: Record<string, any[]> = JSON.parse(jsonMatch[0]);
    const validCategories = Object.entries(aiData).filter(([, v]) => Array.isArray(v) && v.length > 0);
    if (validCategories.length === 0) {
      logger.warn(`[AI:QS] AI returned empty categories at ${lat},${lng}`);
      return { cached: false, results: dbResults };
    }

    // 4. Store in DB cache and in-memory
    await cacheAIQuickSearch(lat, lng, aiData);
    logger.info(`[AI:QS] Cached ${validCategories.length} categories for grid ${latG},${lngG}`);

    // Merge AI + DB results
    const merged: Record<string, any[]> = { ...dbResults };
    for (const [cat, items] of Object.entries(aiData)) {
      if (Array.isArray(items) && items.length) {
        merged[cat] = [...(merged[cat] || []), ...items].slice(0, 10);
      }
    }
    memSet(latG, lngG, merged);
    return { cached: false, results: merged };
  } catch (err: any) {
    logger.error('[AI:QS] Failed:', err.message);
    return { cached: false, results: dbResults };
  }
}

// ── Fire-and-forget AI enrichment (non-blocking) ──────────────
export function triggerAIEnrichmentAsync(lat: number, lng: number): void {
  const key = `${toGrid(lat)},${toGrid(lng)}`;
  if (AI_IN_PROGRESS.has(key)) return;
  AI_IN_PROGRESS.add(key);

  const genericQuery = 'restaurants shops hospitals pharmacies schools banks atm temples hotels nearby';
  aiQuickSearch(lat, lng, genericQuery)
    .then(() => logger.info(`[BG:AI] Enriched cache for ${key}`))
    .catch((err: Error) => logger.warn(`[BG:AI] Enrichment failed ${key}: ${err.message}`))
    .finally(() => AI_IN_PROGRESS.delete(key));
}

// ── SERVICE 1: DB-based nearby places ─────────────────────────
async function populateFromDB(lat: number, lng: number) {
  const latG = toGrid(lat);
  const lngG = toGrid(lng);

  const existingCount = await queryOne<{ c: string }>(
    `SELECT COUNT(*)::int as c FROM quick_search_cache
     WHERE lat_grid=$1 AND lng_grid=$2 AND source='db' AND expires_at > NOW()`,
    [latG, lngG]
  );
  if (parseInt((existingCount as any)?.c || '0') >= DB_CATEGORIES.length) return;

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

  const groups: Record<string, any[]> = {};
  for (const l of listings) {
    const cat = l.type?.toLowerCase() || 'other';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({ id: l.id, name: l.name, address: l.address, city: l.city, phone: l.phone, dist_km: l.dist_km, rate_info: l.rate_info, available_now: l.available_now });
  }
  if (stores.length) {
    groups['shop'] = stores.map((s: any) => ({ id: s.id, name: s.name, address: s.address, city: s.city, dist_km: s.dist_km }));
  }

  for (const [cat, items] of Object.entries(groups)) {
    await upsertCache(latG, lngG, cat, items, 'db');
  }
  if (Object.keys(groups).length > 0) {
    MEM_CACHE.delete(memKey(latG, lngG));
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
  const overpassQuery = `[out:json][timeout:25];(\n${parts}\n);out center 30;`;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(overpassQuery)}`,
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

  const cached = await dbQuery<{ category: string }>(
    `SELECT category FROM quick_search_cache
     WHERE lat_grid=$1 AND lng_grid=$2 AND expires_at > NOW()`,
    [latG, lngG]
  );
  const cachedCats = new Set(cached.map(r => r.category));

  for (const cat of OS_CATEGORIES) {
    if (cachedCats.has(cat)) continue;
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
    const locations = await dbQuery<{ lat: number; lng: number }>(
      `SELECT DISTINCT
         ROUND(lat::numeric, 2) AS lat,
         ROUND(lng::numeric, 2) AS lng
       FROM user_locations
       WHERE updated_at > NOW() - INTERVAL '${ACTIVE_WINDOW_MIN} minutes'`,
      []
    );
    if (!locations.length) return;

    // Find which ones have no/expired cache
    const uncached: Array<{ lat: number; lng: number }> = [];
    for (const loc of locations) {
      const key = memKey(Number(loc.lat), Number(loc.lng));
      if (MEM_CACHE.has(key)) continue; // in-memory hit — skip

      const row = await queryOne<{ c: string }>(
        `SELECT COUNT(*)::int AS c FROM quick_search_cache
         WHERE lat_grid=$1 AND lng_grid=$2 AND expires_at > NOW()`,
        [Number(loc.lat), Number(loc.lng)]
      );
      if (parseInt((row as any)?.c || '0') < 3) {
        uncached.push({ lat: Number(loc.lat), lng: Number(loc.lng) });
      }
    }

    if (!uncached.length) return;

    logger.info(`[BG:AI] Pre-populating ${uncached.length} uncached grid cells`);
    for (const { lat, lng } of uncached) {
      // Stagger AI calls — don't flood in parallel
      await new Promise(r => setTimeout(r, 1000));
      triggerAIEnrichmentAsync(lat, lng);
    }
  } catch (err: any) {
    logger.error('[BG:AI] Job failed:', err.message);
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

  setTimeout(runDBJob,      10_000);
  setTimeout(runOverpassJob, 30_000);
  setTimeout(runAIJob,       60_000); // AI job starts 1 min after boot

  setInterval(runDBJob,       DB_JOB_INTERVAL_MS);
  setInterval(runOverpassJob, OS_JOB_INTERVAL_MS);
  setInterval(runAIJob,       AI_JOB_INTERVAL_MS);

  logger.info('✅ Background services started (DB:2min, Overpass:5min, AI:10min)');
}
