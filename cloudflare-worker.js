/**
 * 台股與美股含息回測工具
 * Yahoo Finance Cloudflare Worker
 * Version: v1.2
 *
 * No API key required.
 * Routes:
 *   GET /health
 *   GET /search?q=3088
 *   GET /chart?symbol=00631L.TW&start=2015-01-01&end=2026-08-09
 */

const VERSION = "v1.2";
const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
const ALLOWED_ORIGINS = new Set([
  "https://jimmyache.github.io",
  "http://localhost:5173",
  "http://localhost:8000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8000",
]);
const US_EXCHANGES = new Set(["NMS","NYQ","NGM","NCM","ASE","PCX","BTS","BATS","NASDAQ","NYSE","NYSEARCA"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") return new Response(null, {status:204, headers:corsHeaders(origin)});
    if (request.method !== "GET") return json({error:"Method not allowed",version:VERSION},405,origin);
    if (origin && !isAllowedOrigin(origin)) return json({error:"Origin not allowed",version:VERSION},403,origin);

    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ok:true,provider:"Yahoo Finance",apiKeyRequired:false,version:VERSION},200,origin,20);
      }
      if (url.pathname === "/search") return await handleSearch(url, origin, ctx);
      if (url.pathname === "/chart") return await handleChart(url, origin, ctx);
      return json({error:"Not found",version:VERSION},404,origin);
    } catch (error) {
      return json({error:friendlyError(error),version:VERSION},502,origin,10);
    }
  },
};

async function handleSearch(url, origin, ctx) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({results:[],version:VERSION},200,origin,300);

  const cacheKey = new Request(`${url.origin}/_cache/v12/search?q=${encodeURIComponent(q.toLowerCase())}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return withCors(cached, origin);

  const params = new URLSearchParams({
    q,
    quotesCount:"40",
    newsCount:"0",
    listsCount:"0",
    enableFuzzyQuery:"false",
    quotesQueryId:"tss_match_phrase_query",
    lang:"zh-Hant",
    region:"TW",
  });

  const payload = await fetchYahooJson(`/v1/finance/search?${params}`, 3);
  const results = (payload.quotes || [])
    .filter(isAllowedSearchQuote)
    .map(x => ({
      symbol:x.symbol,
      name:x.longname || x.shortname || x.symbol,
      exchange:x.exchange || "",
      exchangeDisplay:x.exchDisp || "",
      quoteType:x.quoteType || "",
      currency:x.currency || inferCurrencyFromSymbol(x.symbol || ""),
    }));

  const response = json({results,version:VERSION},200,origin,1800);
  ctx.waitUntil(caches.default.put(cacheKey, stripCors(response.clone())));
  return response;
}

async function handleChart(url, origin, ctx) {
  const symbol = normalizeSymbol(url.searchParams.get("symbol"));
  const start = (url.searchParams.get("start") || "2015-01-01").trim();
  const end = (url.searchParams.get("end") || today()).trim();
  validateChartRequest(symbol, start, end);

  const data = await getChartData(symbol, start, end, url.origin, ctx);
  return json(data,200,origin,cacheTtl(end));
}

async function getChartData(symbol, start, end, originBase, ctx) {
  const cacheKey = new Request(
    `${originBase}/_cache/v12/chart?symbol=${encodeURIComponent(symbol)}&start=${start}&end=${end}`
  );

  const cached = await caches.default.match(cacheKey);
  if (cached) return await cached.json();

  // v1.2：Worker 不再自行做長區間分段。
  // 若整段 Yahoo 查詢失敗，前端會切成較小的 2 年區間再逐段呼叫 /chart。
  // 這樣每一次 Worker invocation 都保持短小，避免 Worker 與瀏覽器 timeout 疊加。
  const data = await fetchYahooChartSegment(symbol, start, end, 2);

  data.source = "Yahoo Finance";
  data.version = VERSION;

  const cachedResponse = new Response(JSON.stringify(data), {
    headers: {
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":`public, max-age=${cacheTtl(end)}`,
    }
  });

  ctx.waitUntil(caches.default.put(cacheKey, cachedResponse));
  return data;
}


async function fetchYahooChartSegment(symbol,start,end,attempts=2) {
  const period1 = Math.floor(Date.parse(`${start}T00:00:00Z`)/1000);
  const period2 = Math.floor((Date.parse(`${end}T00:00:00Z`)+86400000)/1000);
  const params = new URLSearchParams({
    period1:String(period1),
    period2:String(period2),
    interval:"1d",
    events:"div,splits",
    includeAdjustedClose:"true",
  });

  const payload = await fetchYahooJson(
    `/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`,
    attempts
  );

  if (payload?.chart?.error) throw new Error(payload.chart.error.description || "Yahoo Finance chart error");
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo 無 ${symbol} 可用資料`);
  return normalizeYahooChart(result,symbol);
}

async function fetchYahooJson(path, attempts=2) {
  let lastError = null;

  for (let attempt=0; attempt<attempts; attempt++) {
    const host = YAHOO_HOSTS[attempt % YAHOO_HOSTS.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`https://${host}${path}`, {
        headers:{
          Accept:"application/json,text/plain,*/*",
          "Accept-Language":"zh-TW,zh;q=0.9,en;q=0.8",
          Referer:"https://finance.yahoo.com/",
          "User-Agent":"Mozilla/5.0 (compatible; stock-return-backtester/1.2)",
        },
        redirect:"follow",
        signal:controller.signal,
      });

      if (response.ok) {
        const text = await response.text();
        try { return JSON.parse(text); }
        catch { throw new Error("Yahoo 回傳格式錯誤"); }
      }

      const body = await response.text().catch(()=>"");
      lastError = new Error(`Yahoo ${response.status}${body ? `: ${body.slice(0,100)}` : ""}`);
      if (![401,403,408,429,500,502,503,504].includes(response.status)) throw lastError;
    } catch (error) {
      lastError = error?.name === "AbortError" ? new Error("Yahoo 上游連線逾時") : error;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < attempts - 1) {
      await sleep(650 * Math.pow(2,attempt) + Math.floor(Math.random()*220));
    }
  }

  throw lastError || new Error("Yahoo 資料服務連線失敗");
}

function isAllowedSearchQuote(x) {
  const symbol = String(x.symbol || "").toUpperCase();
  const type = String(x.quoteType || "").toUpperCase();
  const exchange = String(x.exchange || "").toUpperCase();
  if (!(type === "EQUITY" || type === "ETF")) return false;
  if (/\.(TW|TWO)$/.test(symbol)) return true;
  if (/\.[A-Z]{1,4}$/.test(symbol)) return false;
  return US_EXCHANGES.has(exchange) || String(x.currency || "").toUpperCase() === "USD";
}

function normalizeYahooChart(result,fallbackSymbol) {
  const meta = result.meta || {};
  const timezone = meta.exchangeTimezoneName || "UTC";
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjclose = result.indicators?.adjclose?.[0]?.adjclose || [];

  const bars = [];
  for (let i=0; i<timestamps.length; i++) {
    const close = Number(quote.close?.[i]);
    if (!Number.isFinite(close) || close <= 0) continue;
    bars.push({
      date:dateInTimeZone(timestamps[i],timezone),
      close,
      adjClose:Number.isFinite(Number(adjclose[i])) ? Number(adjclose[i]) : null,
    });
  }

  const dividends = Object.values(result.events?.dividends || {})
    .map(x => ({date:dateInTimeZone(x.date,timezone),amount:Number(x.amount)}))
    .filter(x => x.date && Number.isFinite(x.amount) && x.amount >= 0)
    .sort((a,b) => a.date.localeCompare(b.date));

  const splits = Object.values(result.events?.splits || {})
    .map(x => ({date:dateInTimeZone(x.date,timezone),ratio:splitRatio(x),raw:x.splitRatio || null}))
    .filter(x => x.date && Number.isFinite(x.ratio) && x.ratio > 0)
    .sort((a,b) => a.date.localeCompare(b.date));

  return {
    symbol:meta.symbol || fallbackSymbol,
    currency:meta.currency || inferCurrencyFromSymbol(fallbackSymbol),
    exchangeName:meta.exchangeName || meta.fullExchangeName || "",
    instrumentType:meta.instrumentType || "",
    timezone,
    firstTradeDate:meta.firstTradeDate ? dateInTimeZone(meta.firstTradeDate,timezone) : null,
    regularMarketPrice:Number.isFinite(Number(meta.regularMarketPrice)) ? Number(meta.regularMarketPrice) : null,
    bars,dividends,splits,
  };
}

function mergeChartParts(parts,fallbackSymbol) {
  if (!parts.length) throw new Error(`Yahoo 無 ${fallbackSymbol} 可用資料`);
  const first = parts[0];
  const barMap = new Map(), dividendMap = new Map(), splitMap = new Map();

  for (const part of parts) {
    for (const row of part.bars || []) if (row?.date) barMap.set(row.date,row);
    for (const row of part.dividends || []) if (row?.date) dividendMap.set(`${row.date}|${row.amount}`,row);
    for (const row of part.splits || []) if (row?.date) splitMap.set(`${row.date}|${row.ratio}`,row);
  }

  return {
    ...first,
    symbol:first.symbol || fallbackSymbol,
    bars:[...barMap.values()].sort((a,b)=>a.date.localeCompare(b.date)),
    dividends:[...dividendMap.values()].sort((a,b)=>a.date.localeCompare(b.date)),
    splits:[...splitMap.values()].sort((a,b)=>a.date.localeCompare(b.date)),
  };
}

function splitRanges(start,end,yearsPerSegment) {
  const out = [];
  let cursor = start;
  while (cursor <= end) {
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear()+yearsPerSegment);
    const candidate = addDays(d.toISOString().slice(0,10),-1);
    const segEnd = candidate < end ? candidate : end;
    out.push([cursor,segEnd]);
    if (segEnd >= end) break;
    cursor = addDays(segEnd,1);
  }
  return out;
}

function validateChartRequest(symbol,start,end) {
  if (!symbol) throw new Error("symbol is required");
  if (!isDate(start) || !isDate(end)) throw new Error("start/end must be YYYY-MM-DD");
  if (start > end) throw new Error("start must be <= end");
}

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function splitRatio(x) {
  const n = Number(x.numerator), d = Number(x.denominator);
  if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) return n/d;
  const m = String(x.splitRatio || "").match(/^\s*([0-9.]+)\s*[:/]\s*([0-9.]+)\s*$/);
  return m ? Number(m[1])/Number(m[2]) : NaN;
}

function inferCurrencyFromSymbol(symbol) {
  if (/\.(TW|TWO)$/i.test(symbol) || symbol === "^TWII" || symbol === "TWD=X") return "TWD";
  return "USD";
}

function friendlyError(error) {
  const message = error?.message || String(error || "Unknown error");
  if (/timeout|逾時/i.test(message)) return "Yahoo 上游連線逾時，請稍後再試";
  if (/429/.test(message)) return "Yahoo 暫時限制請求頻率，請稍後再試";
  if (/fetch failed|failed to fetch/i.test(message)) return "Yahoo 資料服務連線暫時失敗";
  return message;
}

function cacheTtl(end) {
  return end >= addDays(today(),-7) ? 300 : 21600;
}

function dateInTimeZone(unixSeconds,timeZone) {
  if (!unixSeconds) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US",{
      timeZone,year:"numeric",month:"2-digit",day:"2-digit"
    }).formatToParts(new Date(Number(unixSeconds)*1000));
    const map = Object.fromEntries(parts.map(p => [p.type,p.value]));
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return new Date(Number(unixSeconds)*1000).toISOString().slice(0,10);
  }
}

function daysBetween(start,end) {
  return Math.max(0,Math.round((Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`))/86400000));
}
function isDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));
}
function today() { return new Date().toISOString().slice(0,10); }
function addDays(date,days) {
  return new Date(Date.parse(`${date}T00:00:00Z`)+days*86400000).toISOString().slice(0,10);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve,ms)); }

function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin) {
  const allowOrigin = origin && isAllowedOrigin(origin) ? origin : "https://jimmyache.github.io";
  return {
    "Access-Control-Allow-Origin":allowOrigin,
    "Access-Control-Allow-Methods":"GET,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type,Accept",
    "Access-Control-Max-Age":"86400",
    Vary:"Origin",
  };
}

function json(data,status=200,origin="",maxAge=0) {
  const headers = new Headers({"Content-Type":"application/json; charset=utf-8",...corsHeaders(origin)});
  if (maxAge > 0) headers.set("Cache-Control",`public, max-age=${maxAge}`);
  return new Response(JSON.stringify(data),{status,headers});
}

function stripCors(response) {
  const headers = new Headers(response.headers);
  for (const k of ["Access-Control-Allow-Origin","Access-Control-Allow-Methods","Access-Control-Allow-Headers","Access-Control-Max-Age","Vary"]) {
    headers.delete(k);
  }
  return new Response(response.body,{status:response.status,headers});
}

function withCors(response,origin) {
  const headers = new Headers(response.headers);
  for (const [k,v] of Object.entries(corsHeaders(origin))) headers.set(k,v);
  return new Response(response.body,{status:response.status,headers});
}
