/**
 * 台股與美股含息回測工具
 * Yahoo Finance + Cloudflare Workers KV
 *
 * KV Binding：MARKET_DATA
 *
 * 資料路徑：
 *   /chart            使用者主標的，每次直接向 Yahoo 取得，不讀 KV
 *   /benchmark-chart  固定比較基準，只讀 KV，不向 Yahoo fallback
 *   /search           股票搜尋
 *   /health           健康檢查
 *   /cache-status     查看固定比較資料 KV 狀態
 *
 * 固定 KV 標的：
 *   0050.TW
 *   00631L.TW
 *   SPY
 *   ^TWII
 *   TWD=X
 */

const HISTORY_START = "2015-01-01";

const FIXED_SYMBOLS = [
  "0050.TW",
  "00631L.TW",
  "SPY",
  "^TWII",
  "TWD=X",
];

const FIXED_SYMBOL_SET = new Set(FIXED_SYMBOLS);

const YAHOO_HOSTS = [
  "query2.finance.yahoo.com",
  "query1.finance.yahoo.com",
];

const ALLOWED_ORIGINS = new Set([
  "https://jimmyache.github.io",
  "http://localhost:5173",
  "http://localhost:8000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8000",
]);

const US_EXCHANGES = new Set([
  "NMS", "NYQ", "NGM", "NCM", "ASE", "PCX",
  "BTS", "BATS", "NASDAQ", "NYSE", "NYSEARCA",
  "NYSE ARCA", "NYSE MKT",
]);

const BROWSER_HEADERS = {
  "Accept": "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9,zh-TW;q=0.8",
  "Referer": "https://finance.yahoo.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/126.0.0.0 Safari/537.36",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, origin);
    }

    if (origin && !isAllowedOrigin(origin)) {
      return json({ error: "Origin not allowed" }, 403, origin);
    }

    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({
          ok: true,
          provider: "Yahoo Finance",
          apiKeyRequired: false,
          kvReady: Boolean(env.MARKET_DATA),
        }, 200, origin, 20);
      }

      if (url.pathname === "/search") {
        return await handleSearch(url, origin, ctx);
      }

      // 使用者主標的：永遠 Yahoo，不讀 KV。
      if (url.pathname === "/chart") {
        return await handleMainChart(url, origin);
      }

      // 比較基準：永遠 KV，不向 Yahoo fallback。
      if (url.pathname === "/benchmark-chart") {
        if (!env.MARKET_DATA) {
          return json({ error: "MARKET_DATA KV binding 尚未設定" }, 500, origin);
        }
        return await handleBenchmarkChart(url, origin, env);
      }

      if (url.pathname === "/cache-status") {
        if (!env.MARKET_DATA) {
          return json({ error: "MARKET_DATA KV binding 尚未設定" }, 500, origin);
        }
        return await handleCacheStatus(url, origin, env);
      }

      return json({ error: "Not found" }, 404, origin);
    } catch (error) {
      console.error(error);
      return json({ error: friendlyError(error) }, 502, origin, 10);
    }
  },

  // Cron 只更新固定比較標的。
  // 既有設定 30 0 * * * 可繼續使用。
  async scheduled(controller, env, ctx) {
    if (!env.MARKET_DATA) {
      console.error("MARKET_DATA KV binding 尚未設定");
      return;
    }

    for (let i = 0; i < FIXED_SYMBOLS.length; i++) {
      const symbol = FIXED_SYMBOLS[i];

      try {
        await refreshBenchmarkSymbol(symbol, env);
        console.log(`更新成功：${symbol}`);
      } catch (error) {
        // 更新失敗時保留舊 KV，不刪除。
        console.error(`更新失敗：${symbol}`, error?.message || error);
      }

      if (i < FIXED_SYMBOLS.length - 1) {
        await sleep(1200);
      }
    }
  },
};


// =====================================================
// 主標的 /chart：每次直接 Yahoo
// =====================================================

async function handleMainChart(url, origin) {
  const symbol = normalizeSymbol(url.searchParams.get("symbol"));
  const start = (url.searchParams.get("start") || HISTORY_START).trim();
  const end = (url.searchParams.get("end") || today()).trim();

  validateChartRequest(symbol, start, end);

  // 一次 period request；若 Yahoo 對此路徑失敗，再用 range=max 備援。
  // 不做 2 年切段，不讀 KV，不寫 KV。
  const data = await fetchYahooChartWithFallback(symbol, start, end);

  return jsonNoStore({
    ...data,
    availableStart: data.bars?.[0]?.date || null,
    availableEnd: data.bars?.[data.bars.length - 1]?.date || null,
  }, 200, origin);
}

async function fetchYahooChartWithFallback(symbol, start, end) {
  try {
    return await fetchYahooRange(symbol, start, end);
  } catch (periodError) {
    try {
      const maxData = await fetchYahooMaxRange(symbol);
      const filtered = filterChartRange(maxData, start, end);
      if (filtered.bars.length) return filtered;
    } catch {
      // 使用第一個錯誤做最後回報。
    }
    throw periodError;
  }
}


// =====================================================
// 比較基準 /benchmark-chart：只讀 KV
// =====================================================

async function handleBenchmarkChart(url, origin, env) {
  const symbol = normalizeSymbol(url.searchParams.get("symbol"));
  const start = (url.searchParams.get("start") || HISTORY_START).trim();
  const end = (url.searchParams.get("end") || today()).trim();

  validateChartRequest(symbol, start, end);

  if (!FIXED_SYMBOL_SET.has(symbol)) {
    return json({
      error: "此端點只允許固定比較基準",
    }, 400, origin);
  }

  const stored = await env.MARKET_DATA.get(
    marketKey(symbol),
    { type: "json" }
  );

  if (!stored || !Array.isArray(stored.bars) || !stored.bars.length) {
    return json({
      error: "比較基準 KV 尚無資料",
      symbol,
    }, 503, origin);
  }

  const filtered = filterChartRange(stored, start, end);

  return json({
    ...filtered,
    availableStart: stored.bars?.[0]?.date || null,
    availableEnd: stored.bars?.[stored.bars.length - 1]?.date || null,
    cacheSource: "KV",
  }, 200, origin, 300);
}


// =====================================================
// Cron：更新固定比較 KV
// =====================================================

async function refreshBenchmarkSymbol(symbol, env) {
  const normalized = normalizeSymbol(symbol);

  if (!FIXED_SYMBOL_SET.has(normalized)) {
    throw new Error("不是固定比較標的");
  }

  const key = marketKey(normalized);
  const oldData = await env.MARKET_DATA.get(key, { type: "json" });

  let fresh;

  if (oldData && Array.isArray(oldData.bars) && oldData.bars.length) {
    // 已有完整歷史，只補最近 14 天，降低 Yahoo 負擔。
    const lastDate = oldData.bars[oldData.bars.length - 1].date;
    const updateStart = maxDate(HISTORY_START, addDays(lastDate, -14));
    const incremental = await fetchYahooRange(normalized, updateStart, today());
    fresh = mergeMarketData(oldData, incremental);
  } else {
    // KV 第一次建立才抓 2015~今天完整歷史。
    fresh = await fetchYahooFullHistory(normalized);
  }

  const now = new Date().toISOString();
  const stored = {
    ...fresh,
    symbol: fresh.symbol || normalized,
    updatedAt: now,
    lastCheckedAt: now,
  };

  await env.MARKET_DATA.put(
    key,
    JSON.stringify(stored),
    {
      metadata: {
        symbol: normalized,
        updatedAt: now,
        firstBar: stored.bars?.[0]?.date || null,
        lastBar: stored.bars?.[stored.bars.length - 1]?.date || null,
        bars: stored.bars?.length || 0,
      },
    }
  );

  return stored;
}

async function fetchYahooFullHistory(symbol) {
  try {
    return await fetchYahooRange(symbol, HISTORY_START, today());
  } catch (periodError) {
    try {
      const maxData = await fetchYahooMaxRange(symbol);
      const filtered = filterChartRange(maxData, HISTORY_START, today());
      if (filtered.bars.length) return filtered;
    } catch {
      // no-op
    }
    throw periodError;
  }
}


// =====================================================
// Yahoo Chart
// =====================================================

async function fetchYahooRange(symbol, start, end) {
  const period1 = Math.floor(Date.parse(`${start}T00:00:00Z`) / 1000);
  const period2 = Math.floor((Date.parse(`${end}T00:00:00Z`) + 86400000) / 1000);

  const params = new URLSearchParams({
    period1: String(period1),
    period2: String(period2),
    interval: "1d",
    events: "div,splits",
    includeAdjustedClose: "true",
    includePrePost: "false",
    formatted: "false",
  });

  const payload = await fetchYahooJson(
    `/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`,
    2
  );

  return normalizeYahooPayload(payload, symbol);
}

async function fetchYahooMaxRange(symbol) {
  const params = new URLSearchParams({
    range: "max",
    interval: "1d",
    events: "div,splits",
    includeAdjustedClose: "true",
    includePrePost: "false",
    formatted: "false",
  });

  const payload = await fetchYahooJson(
    `/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`,
    2
  );

  return normalizeYahooPayload(payload, symbol);
}

async function fetchYahooJson(path, attempts = 2) {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const host = YAHOO_HOSTS[attempt % YAHOO_HOSTS.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(`https://${host}${path}`, {
        headers: BROWSER_HEADERS,
        redirect: "follow",
        signal: controller.signal,
      });

      if (response.ok) {
        const text = await response.text();
        try {
          return JSON.parse(text);
        } catch {
          throw new Error("Yahoo 回傳格式錯誤");
        }
      }

      const body = await response.text().catch(() => "");
      lastError = new Error(
        `Yahoo ${response.status}${body ? `: ${body.slice(0, 120)}` : ""}`
      );

      if (![401, 403, 408, 429, 500, 502, 503, 504].includes(response.status)) {
        throw lastError;
      }
    } catch (error) {
      lastError = error?.name === "AbortError"
        ? new Error("Yahoo 上游連線逾時")
        : error;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < attempts - 1) {
      await sleep(900 + Math.floor(Math.random() * 400));
    }
  }

  throw lastError || new Error("Yahoo 資料服務連線失敗");
}


// =====================================================
// Search：仍直接 Yahoo，僅 Cache API 短暫快取搜尋字串
// =====================================================

async function handleSearch(url, origin, ctx) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ results: [] }, 200, origin, 300);

  const cache = caches.default;
  const cacheKey = new Request(
    `${url.origin}/_search-cache?q=${encodeURIComponent(q.toLowerCase())}`
  );

  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached, origin);

  const params = new URLSearchParams({
    q,
    quotesCount: "40",
    newsCount: "0",
    listsCount: "0",
    enableFuzzyQuery: "false",
    quotesQueryId: "tss_match_phrase_query",
    lang: "zh-Hant",
    region: "TW",
  });

  const payload = await fetchYahooJson(`/v1/finance/search?${params}`, 2);

  const results = (payload.quotes || [])
    .filter(isAllowedSearchQuote)
    .map((x) => ({
      symbol: x.symbol,
      name: x.longname || x.shortname || x.symbol,
      exchange: x.exchange || "",
      exchangeDisplay: x.exchDisp || "",
      quoteType: x.quoteType || "",
      currency: x.currency || inferCurrencyFromSymbol(x.symbol || ""),
    }));

  const response = json({ results }, 200, origin, 1800);
  ctx.waitUntil(cache.put(cacheKey, stripCors(response.clone())));
  return response;
}

function isAllowedSearchQuote(x) {
  const symbol = String(x.symbol || "").toUpperCase();
  const type = String(x.quoteType || "").toUpperCase();
  const exchange = String(x.exchange || "").toUpperCase();

  if (!(type === "EQUITY" || type === "ETF")) return false;
  if (/\.(TW|TWO)$/.test(symbol)) return true;
  if (/\.[A-Z]{1,4}$/.test(symbol)) return false;

  return US_EXCHANGES.has(exchange) ||
    String(x.currency || "").toUpperCase() === "USD";
}


// =====================================================
// Cache status
// =====================================================

async function handleCacheStatus(url, origin, env) {
  const symbol = normalizeSymbol(url.searchParams.get("symbol"));

  if (!symbol) {
    return json({ error: "symbol is required" }, 400, origin);
  }

  if (!FIXED_SYMBOL_SET.has(symbol)) {
    return json({
      symbol,
      exists: false,
      fixedBenchmark: false,
      message: "主標的不存 KV；此診斷只用於固定比較基準",
    }, 200, origin, 30);
  }

  const result = await env.MARKET_DATA.getWithMetadata(
    marketKey(symbol),
    { type: "json" }
  );

  const data = result?.value;

  return json({
    symbol,
    fixedBenchmark: true,
    exists: Boolean(data),
    updatedAt: data?.updatedAt || null,
    lastCheckedAt: data?.lastCheckedAt || null,
    firstBar: data?.bars?.[0]?.date || null,
    lastBar: data?.bars?.[data.bars.length - 1]?.date || null,
    barCount: data?.bars?.length || 0,
    dividendCount: data?.dividends?.length || 0,
    splitCount: data?.splits?.length || 0,
    metadata: result?.metadata || null,
  }, 200, origin, 30);
}


// =====================================================
// Yahoo payload / merge
// =====================================================

function normalizeYahooPayload(payload, symbol) {
  if (payload?.chart?.error) {
    throw new Error(payload.chart.error.description || "Yahoo Finance chart error");
  }

  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo 無 ${symbol} 可用資料`);

  return normalizeYahooChart(result, symbol);
}

function normalizeYahooChart(result, fallbackSymbol) {
  const meta = result.meta || {};
  const timezone = meta.exchangeTimezoneName || "UTC";
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjclose = result.indicators?.adjclose?.[0]?.adjclose || [];

  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = Number(quote.close?.[i]);
    if (!Number.isFinite(close) || close <= 0) continue;

    bars.push({
      date: dateInTimeZone(timestamps[i], timezone),
      close,
      adjClose: Number.isFinite(Number(adjclose[i])) ? Number(adjclose[i]) : null,
    });
  }

  const dividends = Object.values(result.events?.dividends || {})
    .map((x) => ({
      date: dateInTimeZone(x.date, timezone),
      amount: Number(x.amount),
    }))
    .filter((x) => x.date && Number.isFinite(x.amount) && x.amount >= 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const splits = Object.values(result.events?.splits || {})
    .map((x) => ({
      date: dateInTimeZone(x.date, timezone),
      ratio: splitRatio(x),
      raw: x.splitRatio || null,
    }))
    .filter((x) => x.date && Number.isFinite(x.ratio) && x.ratio > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    symbol: meta.symbol || fallbackSymbol,
    currency: meta.currency || inferCurrencyFromSymbol(fallbackSymbol),
    exchangeName: meta.exchangeName || meta.fullExchangeName || "",
    instrumentType: meta.instrumentType || "",
    timezone,
    firstTradeDate: meta.firstTradeDate
      ? dateInTimeZone(meta.firstTradeDate, timezone)
      : null,
    regularMarketPrice: Number.isFinite(Number(meta.regularMarketPrice))
      ? Number(meta.regularMarketPrice)
      : null,
    bars,
    dividends,
    splits,
  };
}

function mergeMarketData(oldData, newData) {
  const barMap = new Map();
  const dividendMap = new Map();
  const splitMap = new Map();

  for (const row of oldData.bars || []) {
    if (row?.date) barMap.set(row.date, row);
  }
  for (const row of newData.bars || []) {
    if (row?.date) barMap.set(row.date, row);
  }

  for (const row of oldData.dividends || []) {
    if (row?.date) dividendMap.set(`${row.date}|${row.amount}`, row);
  }
  for (const row of newData.dividends || []) {
    if (row?.date) dividendMap.set(`${row.date}|${row.amount}`, row);
  }

  for (const row of oldData.splits || []) {
    if (row?.date) splitMap.set(`${row.date}|${row.ratio}`, row);
  }
  for (const row of newData.splits || []) {
    if (row?.date) splitMap.set(`${row.date}|${row.ratio}`, row);
  }

  return {
    ...oldData,
    ...newData,
    symbol: newData.symbol || oldData.symbol,
    bars: [...barMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    dividends: [...dividendMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    splits: [...splitMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function filterChartRange(data, start, end) {
  return {
    ...data,
    bars: (data.bars || []).filter((x) => x.date >= start && x.date <= end),
    dividends: (data.dividends || []).filter((x) => x.date >= start && x.date <= end),
    splits: (data.splits || []).filter((x) => x.date >= start && x.date <= end),
  };
}


// =====================================================
// Helpers
// =====================================================

function marketKey(symbol) {
  return `market:${normalizeSymbol(symbol)}`;
}

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function inferCurrencyFromSymbol(symbol) {
  if (/\.(TW|TWO)$/i.test(symbol) || symbol === "^TWII" || symbol === "TWD=X") {
    return "TWD";
  }
  return "USD";
}

function splitRatio(x) {
  const n = Number(x.numerator);
  const d = Number(x.denominator);

  if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) {
    return n / d;
  }

  const match = String(x.splitRatio || "").match(
    /^\s*([0-9.]+)\s*[:/]\s*([0-9.]+)\s*$/
  );

  return match ? Number(match[1]) / Number(match[2]) : NaN;
}

function validateChartRequest(symbol, start, end) {
  if (!symbol) throw new Error("symbol is required");
  if (!isDate(start) || !isDate(end)) {
    throw new Error("start/end must be YYYY-MM-DD");
  }
  if (start > end) throw new Error("start must be <= end");
}

function friendlyError(error) {
  const message = error?.message || String(error || "Unknown error");
  if (/timeout|逾時/i.test(message)) return "Yahoo 上游連線逾時";
  if (/429/.test(message)) return "Yahoo 暫時限制請求頻率";
  if (/fetch failed|failed to fetch/i.test(message)) {
    return "Yahoo 資料服務連線暫時失敗";
  }
  return message;
}

function dateInTimeZone(unixSeconds, timeZone) {
  if (!unixSeconds) return null;

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(Number(unixSeconds) * 1000));

    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 10);
  }
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(
    Date.parse(`${date}T00:00:00Z`) + days * 86400000
  ).toISOString().slice(0, 10);
}

function maxDate(a, b) {
  return a > b ? a : b;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// =====================================================
// CORS / JSON
// =====================================================

function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin) {
  const allowOrigin = origin && isAllowedOrigin(origin)
    ? origin
    : "https://jimmyache.github.io";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function jsonNoStore(data, status = 200, origin = "") {
  const response = json(data, status, origin, 0);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

function json(data, status = 200, origin = "", maxAge = 0) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(origin),
  });

  if (maxAge > 0) {
    headers.set("Cache-Control", `public, max-age=${maxAge}`);
  }

  return new Response(JSON.stringify(data), { status, headers });
}

function stripCors(response) {
  const headers = new Headers(response.headers);
  for (const key of [
    "Access-Control-Allow-Origin",
    "Access-Control-Allow-Methods",
    "Access-Control-Allow-Headers",
    "Access-Control-Max-Age",
    "Vary",
  ]) {
    headers.delete(key);
  }

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}
