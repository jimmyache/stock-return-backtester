/**
 * Yahoo Finance proxy for stock-return-backtester
 * Cloudflare Worker, no API key / secret required.
 *
 * Routes:
 *   GET /health
 *   GET /search?q=2330
 *   GET /chart?symbol=2330.TW&start=2015-01-01&end=2026-08-07
 */

const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
const ALLOWED_ORIGINS = new Set([
  "https://jimmyache.github.io",
  "http://localhost:5173",
  "http://localhost:8000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8000",
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, origin);
    }

    if (origin && !isAllowedOrigin(origin)) {
      return json({ error: "Origin not allowed" }, 403, origin);
    }

    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ ok: true, provider: "Yahoo Finance", apiKeyRequired: false }, 200, origin, 60);
      }

      if (url.pathname === "/search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json({ results: [] }, 200, origin, 300);
        const cacheKey = new Request(`${url.origin}/_cache/search?q=${encodeURIComponent(q.toLowerCase())}`);
        const cached = await caches.default.match(cacheKey);
        if (cached) return withCors(cached, origin);

        const params = new URLSearchParams({
          q,
          quotesCount: "30",
          newsCount: "0",
          listsCount: "0",
          enableFuzzyQuery: "false",
          quotesQueryId: "tss_match_phrase_query",
        });
        const upstream = await fetchYahoo(`/v1/finance/search?${params}`);
        const payload = await upstream.json();
        const results = (payload.quotes || [])
          .filter((x) => ["EQUITY", "ETF", "INDEX", "MUTUALFUND"].includes(x.quoteType))
          .map((x) => ({
            symbol: x.symbol,
            name: x.longname || x.shortname || x.symbol,
            exchange: x.exchange || "",
            exchangeDisplay: x.exchDisp || "",
            quoteType: x.quoteType || "",
            currency: inferCurrency(x),
          }));

        const response = json({ results }, 200, origin, 3600);
        ctx.waitUntil(caches.default.put(cacheKey, stripCors(response.clone())));
        return response;
      }

      if (url.pathname === "/chart") {
        const symbol = (url.searchParams.get("symbol") || "").trim();
        const start = (url.searchParams.get("start") || "1990-01-01").trim();
        const end = (url.searchParams.get("end") || today()).trim();
        if (!symbol) return json({ error: "symbol is required" }, 400, origin);
        if (!isDate(start) || !isDate(end)) return json({ error: "start/end must be YYYY-MM-DD" }, 400, origin);
        if (start > end) return json({ error: "start must be <= end" }, 400, origin);

        const period1 = Math.floor(Date.parse(`${start}T00:00:00Z`) / 1000);
        const period2 = Math.floor((Date.parse(`${end}T00:00:00Z`) + 86400000) / 1000);
        const normalizedSymbol = symbol.toUpperCase();
        const cacheKey = new Request(`${url.origin}/_cache/chart?symbol=${encodeURIComponent(normalizedSymbol)}&start=${start}&end=${end}`);
        const cached = await caches.default.match(cacheKey);
        if (cached) return withCors(cached, origin);

        const params = new URLSearchParams({
          period1: String(period1),
          period2: String(period2),
          interval: "1d",
          events: "div,splits",
          includeAdjustedClose: "true",
        });
        const upstream = await fetchYahoo(`/v8/finance/chart/${encodeURIComponent(normalizedSymbol)}?${params}`);
        const payload = await upstream.json();
        if (payload?.chart?.error) {
          return json({ error: payload.chart.error.description || "Yahoo Finance error" }, 502, origin, 30);
        }
        const result = payload?.chart?.result?.[0];
        if (!result) return json({ error: `No Yahoo Finance data for ${normalizedSymbol}` }, 404, origin, 60);

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

        const responseBody = {
          symbol: meta.symbol || normalizedSymbol,
          currency: meta.currency || inferCurrencyFromSymbol(normalizedSymbol),
          exchangeName: meta.exchangeName || meta.fullExchangeName || "",
          instrumentType: meta.instrumentType || "",
          timezone,
          firstTradeDate: meta.firstTradeDate ? dateInTimeZone(meta.firstTradeDate, timezone) : null,
          regularMarketPrice: Number.isFinite(Number(meta.regularMarketPrice)) ? Number(meta.regularMarketPrice) : null,
          bars,
          dividends,
          splits,
          source: "Yahoo Finance",
        };

        const ttl = end >= addDays(today(), -7) ? 300 : 21600;
        const response = json(responseBody, 200, origin, ttl);
        ctx.waitUntil(caches.default.put(cacheKey, stripCors(response.clone())));
        return response;
      }

      return json({ error: "Not found" }, 404, origin);
    } catch (error) {
      return json({ error: error?.message || String(error) }, 500, origin, 30);
    }
  },
};

async function fetchYahoo(path) {
  let lastError = null;
  for (const host of YAHOO_HOSTS) {
    try {
      const response = await fetch(`https://${host}${path}`, {
        headers: {
          Accept: "application/json,text/plain,*/*",
          "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
          Referer: "https://finance.yahoo.com/",
          "User-Agent": "Mozilla/5.0 (compatible; stock-return-backtester/0.3)",
        },
        cf: { cacheEverything: false },
      });
      if (response.ok) return response;
      lastError = new Error(`Yahoo Finance ${response.status} ${response.statusText}`);
      if (![401, 403, 404, 429, 500, 502, 503].includes(response.status)) break;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Yahoo Finance request failed");
}

function splitRatio(x) {
  const numerator = Number(x.numerator);
  const denominator = Number(x.denominator);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) return numerator / denominator;
  const text = String(x.splitRatio || "");
  const m = text.match(/^\s*([0-9.]+)\s*[:/]\s*([0-9.]+)\s*$/);
  return m ? Number(m[1]) / Number(m[2]) : NaN;
}

function inferCurrency(x) {
  if (x.currency) return x.currency;
  return inferCurrencyFromSymbol(x.symbol || "");
}

function inferCurrencyFromSymbol(symbol) {
  if (/\.(TW|TWO)$/i.test(symbol) || symbol === "^TWII") return "TWD";
  if (symbol === "TWD=X") return "TWD";
  return "USD";
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

function isDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin) {
  const allowOrigin = origin && isAllowedOrigin(origin) ? origin : "https://jimmyache.github.io";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(data, status = 200, origin = "", maxAge = 0) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(origin),
  });
  if (maxAge > 0) headers.set("Cache-Control", `public, max-age=${maxAge}`);
  return new Response(JSON.stringify(data), { status, headers });
}

function stripCors(response) {
  const headers = new Headers(response.headers);
  headers.delete("Access-Control-Allow-Origin");
  headers.delete("Access-Control-Allow-Methods");
  headers.delete("Access-Control-Allow-Headers");
  headers.delete("Vary");
  return new Response(response.body, { status: response.status, headers });
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}
