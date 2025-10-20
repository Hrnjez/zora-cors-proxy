// BACKEND FILE: /pages/api/zora-marketcap.js
// Copy this file to your Vercel project at: pages/api/zora-marketcap.js

import { getProfile, setApiKey } from "@zoralabs/coins-sdk";

/**
 * =========================
 * Config
 * =========================
 */
const ALLOWED_ORIGINS = [
  "https://app-landing-page-da9939-9d27738bf8d68dc.webflow.io",
  "https://app.zora.co",
  "https://app-landing-page-da9939.webflow.io",
  // Add your production domains here
];

const TARGET_HANDLE = "propaganda";  // The profile to track
const TIMEOUT_MS = 8000;             // API call timeout
const RETRIES = 2;                   // Retry attempts
const BACKOFF_BASE_MS = 250;         // Exponential backoff base
const CACHE_TTL_MS = 30_000;         // 30s cache (aggressive for high traffic)
const STALE_WHILE_REVALIDATE_MS = 60_000; // Serve stale data while fetching fresh

/**
 * =========================
 * In-memory cache with stale-while-revalidate
 * =========================
 */
let cache = {
  data: null,
  expiresAt: 0,
  staleUntil: 0,
  isRevalidating: false,
  revalidationPromise: null,
};

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(fn, { retries = RETRIES, label = "op" } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries) throw e;
      const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt) + Math.random() * 100;
      await sleep(backoff);
      attempt++;
    }
  }
}

/**
 * =========================
 * Fetch market cap with smart caching
 * =========================
 */
async function fetchMarketCap() {
  const now = Date.now();

  // Fresh cache hit
  if (cache.data && cache.expiresAt > now) {
    return { data: cache.data, source: "cache-fresh" };
  }

  // Stale-while-revalidate: serve stale, trigger background refresh
  if (cache.data && cache.staleUntil > now) {
    // Start background revalidation (only if not already in progress)
    if (!cache.isRevalidating) {
      cache.isRevalidating = true;
      cache.revalidationPromise = (async () => {
        try {
          const freshData = await fetchFromZora();
          updateCache(freshData);
        } catch (e) {
          console.error("Background revalidation failed:", e.message);
        } finally {
          cache.isRevalidating = false;
          cache.revalidationPromise = null;
        }
      })();
    }
    return { data: cache.data, source: "cache-stale" };
  }

  // Cache miss or expired: fetch fresh data
  // If revalidation is in progress, wait for it
  if (cache.revalidationPromise) {
    await cache.revalidationPromise;
    return { data: cache.data, source: "cache-revalidated" };
  }

  // Fresh fetch
  const freshData = await fetchFromZora();
  updateCache(freshData);
  return { data: freshData, source: "live" };
}

async function fetchFromZora() {
  const resp = await withRetry(
    () => withTimeout(getProfile({ identifier: TARGET_HANDLE }), TIMEOUT_MS),
    { label: `getProfile:${TARGET_HANDLE}` }
  );

  const profile = resp?.data?.profile;
  if (!profile) {
    throw new Error("Profile not found");
  }

  // Extract market cap - adjust path based on Zora SDK response structure
  const marketCap = profile.marketCap || profile.coin?.marketCap || null;
  const symbol = profile.symbol || profile.coin?.symbol || null;
  const price = profile.price || profile.coin?.price || null;

  return {
    handle: TARGET_HANDLE,
    marketCap,
    symbol,
    price,
    timestamp: Date.now(),
  };
}

function updateCache(data) {
  const now = Date.now();
  cache = {
    data,
    expiresAt: now + CACHE_TTL_MS,
    staleUntil: now + CACHE_TTL_MS + STALE_WHILE_REVALIDATE_MS,
    isRevalidating: false,
    revalidationPromise: null,
  };
}

/**
 * =========================
 * Handler
 * =========================
 */
export default async function handler(req, res) {
  allowCors(req, res);

  // Aggressive edge caching with stale-while-revalidate
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=30, stale-while-revalidate=60"
  );

  if (req.method === "OPTIONS" || req.method === "HEAD") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const ZORA_API_KEY = process.env.ZORA_API_KEY;
    if (!ZORA_API_KEY) {
      return res.status(500).json({ 
        error: "Server misconfiguration",
        message: "ZORA_API_KEY not set"
      });
    }
    setApiKey(ZORA_API_KEY);

    const startedAt = Date.now();
    const result = await fetchMarketCap();
    const durationMs = Date.now() - startedAt;

    return res.status(200).json({
      success: true,
      data: result.data,
      meta: {
        source: result.source,
        durationMs,
        cacheTtlMs: CACHE_TTL_MS,
        handle: TARGET_HANDLE,
      },
    });
  } catch (err) {
    console.error("Market cap fetch error:", err);
    
    // If we have stale data, serve it even on error
    if (cache.data) {
      return res.status(200).json({
        success: true,
        data: cache.data,
        meta: {
          source: "cache-error-fallback",
          error: err.message,
          handle: TARGET_HANDLE,
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: "Failed to fetch market cap",
      message: err?.message || String(err),
    });
  }
}
