// /pages/api/zora-profiles.js
import { getProfile, getProfileCoins, setApiKey } from "@zoralabs/coins-sdk";

/**
 * =========================
 * Config — prilagodi po potrebi
 * =========================
 */
const ALLOWED_ORIGINS = [
  "https://app-landing-page-da9939-9d27738bf8d68dc.webflow.io",
  "https://app.zora.co",
  "https://mkt.zora.co",
  "https://app-landing-page-da9939.webflow.io",
]; // ← zameni svojim domenima (Webflow/Vercel)

const MAX_HANDLES = 20;        // max kreatora po zahtevu (sprečava ekstremni fan-out)
const URL_MAX_LENGTH = 2000;   // zaštita od predugačkog GET URL-a
const CONCURRENCY = 6;         // 5–8 je zdravo: ravnomerno pritiska Zora API
const TIMEOUT_MS = 8000;       // hard timeout po Zora pozivu
const RETRIES = 2;             // ukupno pokušaja = RETRIES + 1
const BACKOFF_BASE_MS = 250;   // expo backoff + jitter
const CACHE_TTL_MS = 90_000;   // per-handle in-memory LRU (~90s)
const CACHE_MAX_ENTRIES = 1000;

/**
 * =========================
 * Mali in-memory LRU + inflight de-dupe
 * =========================
 */
const cache = new Map();     // key -> { expiresAt, value }
const inflight = new Map();  // key -> Promise

const ck = (kind, handle, extra = "") =>
  `${kind}:${(handle || "").toLowerCase()}:${extra}`;

function getCached(key) {
  const now = Date.now();
  const item = cache.get(key);
  if (!item) return null;
  if (item.expiresAt <= now) { cache.delete(key); return null; }
  // LRU bump
  cache.delete(key);
  cache.set(key, item);
  return item.value;
}

function setCached(key, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * =========================
 * Helpers
 * =========================
 */
function allowCors(req, res) {
  const origin = req.headers.origin;
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withTimeout(promise, ms) {
  let t; try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => (t = setTimeout(() => rej(new Error("Timeout")), ms))),
    ]);
  } finally { clearTimeout(t); }
}

async function withRetry(fn, { retries = RETRIES, label = "op" } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { return await fn(); }
    catch (e) {
      if (attempt >= retries) throw e;
      const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt) + Math.random() * 100;
      // optional debug:
      // console.warn(`[retry] ${label} failed (attempt ${attempt+1}): ${e?.message}`);
      await sleep(backoff);
      attempt++;
    }
  }
}

async function pool(items, worker, concurrency = CONCURRENCY) {
  const out = new Array(items.length);
  let i = 0;
  async function next() {
    const idx = i++;
    if (idx >= items.length) return;
    try { out[idx] = await worker(items[idx], idx); }
    catch (e) { out[idx] = e; }
    return next();
  }
  const starters = Array.from({ length: Math.min(concurrency, items.length) }, next);
  await Promise.all(starters);
  return out;
}

/**
 * =========================
 * Fetchers (cached + coalesced)
 * =========================
 */
async function fetchProfile(handle) {
  const key = ck("profile", handle);
  const cached = getCached(key);
  if (cached) return { source: "cache", data: cached };

  if (inflight.has(key)) {
    const data = await inflight.get(key);
    return { source: "inflight", data };
  }

  const p = (async () => {
    const resp = await withRetry(
      () => withTimeout(getProfile({ identifier: handle }), TIMEOUT_MS),
      { label: `getProfile:${handle}` }
    );
    const profile = resp?.data?.profile ?? null;
    setCached(key, profile);
    return profile;
  })();

  inflight.set(key, p);
  try {
    const data = await p;
    return { source: "live", data };
  } finally {
    inflight.delete(key);
  }
}

async function fetchCoins(handle, count = 3) {
  const key = ck("coins", handle, String(count));
  const cached = getCached(key);
  if (cached) return { source: "cache", data: cached };

  if (inflight.has(key)) {
    const data = await inflight.get(key);
    return { source: "inflight", data };
  }

  const p = (async () => {
    const resp = await withRetry(
      () => withTimeout(getProfileCoins({ identifier: handle, count }), TIMEOUT_MS),
      { label: `getProfileCoins:${handle}` }
    );
    const posts = resp?.data?.profile?.createdCoins?.edges ?? [];
    setCached(key, posts);
    return posts;
  })();

  inflight.set(key, p);
  try {
    const data = await p;
    return { source: "live", data };
  } finally {
    inflight.delete(key);
  }
}

/**
 * =========================
 * Handler
 * =========================
 */
export default async function handler(req, res) {
  allowCors(req, res);

  // Edge/CDN cache (Vercel): 120s + SWR 120s
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=120");

  if (req.method === "OPTIONS" || req.method === "HEAD") {
    return res.status(204).end();
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const ZORA_API_KEY = process.env.ZORA_API_KEY;
    if (!ZORA_API_KEY) {
      return res.status(500).json({ error: "Server misconfig: ZORA_API_KEY is not defined" });
    }
    setApiKey(ZORA_API_KEY);

    // ---- Input: prefer POST JSON { handles: string[] | string }, GET fallback ?handles=a,b,c
    let rawHandles;
    if (req.method === "POST") {
      const ct = String(req.headers["content-type"] || "");
      if (!ct.includes("application/json")) {
        return res.status(415).json({ error: "Use application/json body" });
      }
      rawHandles = req.body?.handles;
    } else {
      // GET fallback with URL length guard (radi CDN edge cache)
      if ((req.url || "").length > URL_MAX_LENGTH) {
        return res.status(414).json({ error: "URL too long; use POST / JSON body" });
      }
      rawHandles = req.query?.handles;
    }

    if (!rawHandles || (Array.isArray(rawHandles) && rawHandles.length === 0)) {
      return res.status(400).json({ error: "Missing handles (POST {handles} or ?handles=...)" });
    }

    let handlesList = Array.isArray(rawHandles) ? rawHandles : String(rawHandles).split(",");
    handlesList = handlesList
      .map(h => String(h).trim())
      .filter(Boolean)
      .map(h => h.replace(/^@/, "")); // dozvoli @handle

    // dedupe (case-insensitive) + sort (stabilan URL za CDN HIT-ove na GET-u)
    const seen = new Set();
    handlesList = handlesList.filter(h => {
      const key = h.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    if (handlesList.length === 0) {
      return res.status(400).json({ error: "No valid handles provided" });
    }
    if (handlesList.length > MAX_HANDLES) {
      return res.status(400).json({
        error: `Too many handles; max ${MAX_HANDLES}`,
        max: MAX_HANDLES,
        received: handlesList.length,
      });
    }

    const startedAt = Date.now();

    // Obrada sa malim pool-om (kontrolisana konkurentnost)
    const results = await pool(
      handlesList,
      async (handle) => {
        try {
          const [p, c] = await Promise.all([fetchProfile(handle), fetchCoins(handle, 3)]);
          const profile = p.data ?? null;
          const posts = c.data ?? [];
          return {
            handle,
            ok: true,
            profile,
            posts,
            sources: { profile: p.source, posts: c.source }, // "cache" | "inflight" | "live"
          };
        } catch (e) {
          return {
            handle,
            ok: false,
            profile: null,
            posts: [],
            error: e?.message || "Unknown error",
          };
        }
      },
      CONCURRENCY
    );

    const hadErrors = results.some(r => !r.ok);
    const durationMs = Date.now() - startedAt;

    return res.status(200).json({
      profiles: results,
      meta: {
        count: results.length,
        hadErrors,
        durationMs,
        concurrency: CONCURRENCY,
        cacheTtlMs: CACHE_TTL_MS,
      },
    });
  } catch (err) {
    console.error("Zora profiles fetch error:", err);
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
