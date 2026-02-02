// BACKEND FILE: /pages/api/get-propaganda.js
// Copy this to your Vercel project at: pages/api/get-propaganda.js

import { getProfile, setApiKey } from "@zoralabs/coins-sdk";

/**
 * Config
 */
const ALLOWED_ORIGINS = [
  "https://propaganda-747205.webflow.io",
  "https://www.propaganda.now"
];

const TARGET_HANDLE = "propaganda";
const TIMEOUT_MS = 8000;
const RETRIES = 2;
const BACKOFF_BASE_MS = 250;
const CACHE_TTL_MS = 30_000; // 30s cache
const STALE_WHILE_REVALIDATE_MS = 60_000; // 60s stale

/**
 * In-memory cache
 */
let cache = {
  data: null,
  expiresAt: 0,
  staleUntil: 0,
  isRevalidating: false,
  revalidationPromise: null,
};

/**
 * Helpers
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

async function withRetry(fn, { retries = RETRIES } = {}) {
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
 * Fetch market cap with smart caching
 */
async function fetchMarketCap() {
  const now = Date.now();

  // Fresh cache hit
  if (cache.data && cache.expiresAt > now) {
    return { data: cache.data, source: "cache-fresh" };
  }

  // Stale-while-revalidate
  if (cache.data && cache.staleUntil > now) {
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

  // Wait for revalidation if in progress
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
  console.log('Fetching profile for:', TARGET_HANDLE);
  
  const resp = await withRetry(
    () => withTimeout(getProfile({ identifier: TARGET_HANDLE }), TIMEOUT_MS)
  );

  console.log('SDK response:', JSON.stringify(resp, null, 2));

  // Try multiple possible response structures (v0.3.1 vs v0.4.3)
  const profile = 
    resp?.data?.profile ||     // v0.3.1 structure
    resp?.profile ||           // Possible v0.4.3 structure
    resp?.data ||              // Another possible structure
    resp;                      // Direct response

  if (!profile || (typeof profile === 'object' && Object.keys(profile).length === 0)) {
    console.error('Profile not found. Full response:', resp);
    throw new Error("Profile not found");
  }

  console.log('Profile extracted successfully');

  return {
    handle: TARGET_HANDLE,
    profile: profile,
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
 * Handler
 */
export default async function handler(req, res) {
  allowCors(req, res);
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");

  if (req.method === "OPTIONS" || req.method === "HEAD") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const ZORA_API_KEY = process.env.ZORA_API_KEY;
    if (!ZORA_API_KEY) {
      console.error("ZORA_API_KEY not set");  // Add logging
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
        handle: TARGET_HANDLE,
      },
    });
  } catch (err) {
    console.error("Market cap fetch error:", err);
    console.error("Error stack:", err.stack);  // Add full stack trace
    console.error("Error details:", JSON.stringify(err, null, 2));  // Add error details
    
    // Serve stale data on error
    if (cache.data) {
      return res.status(200).json({
        success: true,
        data: cache.data,
        meta: {
          source: "cache-error-fallback",
          error: err.message,
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: "Failed to fetch market cap",
      message: err?.message || String(err),
      stack: err?.stack,  // Include stack in response for debugging
    });
  }
}