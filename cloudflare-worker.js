/**
 * stock-return-backtester Yahoo proxy
 * Cloudflare Worker v0.9
 * No API key required.
 */
const VERSION = "v0.9";
const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
const ALLOWED_ORIGINS = new Set([
  "https://jimmyache.github.io",
  "http://localhost:5173",
  "http://localhost:8000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8000",
]);
const MAX_SEGMENT_YEARS = 5;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") return new Response(null, {status:204, headers:corsHeaders(origin)});
    if (request.method !== "GET") return json({error:"Method not allowed"},405,origin);
    if (origin && !isAllowedOrigin(origin)) return json({error:"Origin not allowed"},403,origin);

    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ok:true,provider:"Yahoo Finance",apiKeyRequired:false,version:VERSION},200,origin,30);
      }
      if (url.pathname === "/search") return await handleSearch(url,origin,ctx);
      if (url.pathname === "/chart") return await handleChart(url,origin,ctx);
      return json({error:"Not found"},404,origin);
    } catch (error) {
      return json({error:friendlyError(error),version:VERSION},502,origin,15);
    }
  },
};

async function handleSearch(url, origin, ctx) {
  const q=(url.searchParams.get("q")||"").trim();
  if(!q) return json({results:[]},200,origin,300);

  const cacheKey=new Request(`${url.origin}/_cache/v09/search?q=${encodeURIComponent(q.toLowerCase())}`);
  const cached=await caches.default.match(cacheKey);
  if(cached) return withCors(cached,origin);

  const params=new URLSearchParams({
    q,quotesCount:"30",newsCount:"0",listsCount:"0",
    enableFuzzyQuery:"false",quotesQueryId:"tss_match_phrase_query",
    lang:"zh-Hant",region:"TW"
  });
  const payload=await fetchYahooJson(`/v1/finance/search?${params}`,5);
  const results=(payload.quotes||[])
    .filter(x=>["EQUITY","ETF","INDEX","MUTUALFUND"].includes(x.quoteType))
    .map(x=>({
      symbol:x.symbol,
      name:x.longname||x.shortname||x.symbol,
      exchange:x.exchange||"",
      exchangeDisplay:x.exchDisp||"",
      quoteType:x.quoteType||"",
      currency:inferCurrency(x),
    }));
  const response=json({results,version:VERSION},200,origin,3600);
  ctx.waitUntil(caches.default.put(cacheKey,stripCors(response.clone())));
  return response;
}

async function handleChart(url, origin, ctx) {
  const symbol=(url.searchParams.get("symbol")||"").trim().toUpperCase();
  const start=(url.searchParams.get("start")||"1990-01-01").trim();
  const end=(url.searchParams.get("end")||today()).trim();

  if(!symbol) return json({error:"symbol is required"},400,origin);
  if(!isDate(start)||!isDate(end)) return json({error:"start/end must be YYYY-MM-DD"},400,origin);
  if(start>end) return json({error:"start must be <= end"},400,origin);

  const cacheKey=new Request(`${url.origin}/_cache/v09/chart?symbol=${encodeURIComponent(symbol)}&start=${start}&end=${end}`);
  const cached=await caches.default.match(cacheKey);
  if(cached) return withCors(cached,origin);

  const ranges=splitRanges(start,end,MAX_SEGMENT_YEARS);
  const parts=[];
  for(let i=0;i<ranges.length;i++){
    const [segStart,segEnd]=ranges[i];
    parts.push(await fetchYahooChartSegment(symbol,segStart,segEnd));
    if(i<ranges.length-1) await sleep(140);
  }

  const merged=mergeChartParts(parts,symbol);
  merged.source="Yahoo Finance";
  merged.version=VERSION;
  const ttl=end>=addDays(today(),-7)?300:21600;
  const response=json(merged,200,origin,ttl);
  ctx.waitUntil(caches.default.put(cacheKey,stripCors(response.clone())));
  return response;
}

async function fetchYahooChartSegment(symbol,start,end){
  const period1=Math.floor(Date.parse(`${start}T00:00:00Z`)/1000);
  const period2=Math.floor((Date.parse(`${end}T00:00:00Z`)+86400000)/1000);
  const params=new URLSearchParams({
    period1:String(period1),period2:String(period2),interval:"1d",
    events:"div,splits",includeAdjustedClose:"true"
  });
  const payload=await fetchYahooJson(`/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`,4);
  if(payload?.chart?.error) throw new Error(payload.chart.error.description||"Yahoo Finance chart error");
  const result=payload?.chart?.result?.[0];
  if(!result) throw new Error(`No Yahoo Finance data for ${symbol}`);
  return normalizeYahooChart(result,symbol);
}

async function fetchYahooJson(path,attempts=4){
  let lastError=null;
  for(let attempt=0;attempt<attempts;attempt++){
    const host=YAHOO_HOSTS[attempt%YAHOO_HOSTS.length];
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),18000);
    try{
      const response=await fetch(`https://${host}${path}`,{
        headers:{
          Accept:"application/json,text/plain,*/*",
          "Accept-Language":"zh-TW,zh;q=0.9,en;q=0.8",
          Referer:"https://finance.yahoo.com/",
          "User-Agent":"Mozilla/5.0 (compatible; stock-return-backtester/0.9)",
          "Cache-Control":"no-cache",
        },
        redirect:"follow",
        signal:controller.signal,
      });
      if(response.ok){
        const text=await response.text();
        try{return JSON.parse(text)}catch{throw new Error("Yahoo returned invalid JSON")}
      }
      const body=await response.text().catch(()=>"");
      lastError=new Error(`Yahoo ${response.status}${body?`: ${body.slice(0,120)}`:""}`);
      if(![401,403,408,429,500,502,503,504].includes(response.status)) throw lastError;
    }catch(error){
      lastError=error?.name==="AbortError"?new Error("Yahoo upstream timeout"):error;
    }finally{
      clearTimeout(timer);
    }
    if(attempt<attempts-1) await sleep(350*Math.pow(2,attempt)+Math.floor(Math.random()*180));
  }
  throw lastError||new Error("Yahoo request failed");
}

function normalizeYahooChart(result,fallbackSymbol){
  const meta=result.meta||{};
  const timezone=meta.exchangeTimezoneName||"UTC";
  const timestamps=result.timestamp||[];
  const quote=result.indicators?.quote?.[0]||{};
  const adjclose=result.indicators?.adjclose?.[0]?.adjclose||[];
  const bars=[];
  for(let i=0;i<timestamps.length;i++){
    const close=Number(quote.close?.[i]);
    if(!Number.isFinite(close)||close<=0) continue;
    bars.push({
      date:dateInTimeZone(timestamps[i],timezone),
      close,
      adjClose:Number.isFinite(Number(adjclose[i]))?Number(adjclose[i]):null,
    });
  }
  const dividends=Object.values(result.events?.dividends||{})
    .map(x=>({date:dateInTimeZone(x.date,timezone),amount:Number(x.amount)}))
    .filter(x=>x.date&&Number.isFinite(x.amount)&&x.amount>=0)
    .sort((a,b)=>a.date.localeCompare(b.date));
  const splits=Object.values(result.events?.splits||{})
    .map(x=>({date:dateInTimeZone(x.date,timezone),ratio:splitRatio(x),raw:x.splitRatio||null}))
    .filter(x=>x.date&&Number.isFinite(x.ratio)&&x.ratio>0)
    .sort((a,b)=>a.date.localeCompare(b.date));

  return {
    symbol:meta.symbol||fallbackSymbol,
    currency:meta.currency||inferCurrencyFromSymbol(fallbackSymbol),
    exchangeName:meta.exchangeName||meta.fullExchangeName||"",
    instrumentType:meta.instrumentType||"",
    timezone,
    firstTradeDate:meta.firstTradeDate?dateInTimeZone(meta.firstTradeDate,timezone):null,
    regularMarketPrice:Number.isFinite(Number(meta.regularMarketPrice))?Number(meta.regularMarketPrice):null,
    bars,dividends,splits,
  };
}

function mergeChartParts(parts,fallbackSymbol){
  if(!parts.length) throw new Error(`No Yahoo Finance data for ${fallbackSymbol}`);
  const first=parts[0],barMap=new Map(),divMap=new Map(),splitMap=new Map();
  for(const part of parts){
    for(const x of part.bars||[]) if(x?.date) barMap.set(x.date,x);
    for(const x of part.dividends||[]) if(x?.date) divMap.set(`${x.date}|${x.amount}`,x);
    for(const x of part.splits||[]) if(x?.date) splitMap.set(`${x.date}|${x.ratio}`,x);
  }
  return {
    ...first,
    symbol:first.symbol||fallbackSymbol,
    bars:[...barMap.values()].sort((a,b)=>a.date.localeCompare(b.date)),
    dividends:[...divMap.values()].sort((a,b)=>a.date.localeCompare(b.date)),
    splits:[...splitMap.values()].sort((a,b)=>a.date.localeCompare(b.date)),
  };
}

function splitRanges(start,end,yearsPerSegment){
  const out=[];let cursor=start;
  while(cursor<=end){
    const d=new Date(`${cursor}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear()+yearsPerSegment);
    const candidate=addDays(d.toISOString().slice(0,10),-1);
    const segEnd=candidate<end?candidate:end;
    out.push([cursor,segEnd]);
    if(segEnd>=end) break;
    cursor=addDays(segEnd,1);
  }
  return out;
}

function splitRatio(x){
  const numerator=Number(x.numerator),denominator=Number(x.denominator);
  if(Number.isFinite(numerator)&&Number.isFinite(denominator)&&denominator!==0) return numerator/denominator;
  const m=String(x.splitRatio||"").match(/^\s*([0-9.]+)\s*[:/]\s*([0-9.]+)\s*$/);
  return m?Number(m[1])/Number(m[2]):NaN;
}
function inferCurrency(x){return x.currency||inferCurrencyFromSymbol(x.symbol||"")}
function inferCurrencyFromSymbol(symbol){
  if(/\.(TW|TWO)$/i.test(symbol)||symbol==="^TWII") return "TWD";
  if(symbol==="TWD=X") return "TWD";
  return "USD";
}
function friendlyError(error){
  const msg=error?.message||String(error||"Unknown error");
  if(/timeout/i.test(msg)) return "Yahoo 上游連線逾時，請稍後重試";
  if(/429/.test(msg)) return "Yahoo 暫時限制請求頻率，請稍後重試";
  return msg;
}
function dateInTimeZone(unixSeconds,timeZone){
  if(!unixSeconds) return null;
  try{
    const parts=new Intl.DateTimeFormat("en-US",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"})
      .formatToParts(new Date(Number(unixSeconds)*1000));
    const map=Object.fromEntries(parts.map(p=>[p.type,p.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }catch{
    return new Date(Number(unixSeconds)*1000).toISOString().slice(0,10);
  }
}
function isDate(s){return /^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(`${s}T00:00:00Z`))}
function today(){return new Date().toISOString().slice(0,10)}
function addDays(date,days){return new Date(Date.parse(`${date}T00:00:00Z`)+days*86400000).toISOString().slice(0,10)}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
function isAllowedOrigin(origin){
  if(ALLOWED_ORIGINS.has(origin)) return true;
  if(/^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
function corsHeaders(origin){
  const allowOrigin=origin&&isAllowedOrigin(origin)?origin:"https://jimmyache.github.io";
  return {
    "Access-Control-Allow-Origin":allowOrigin,
    "Access-Control-Allow-Methods":"GET,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type,Accept",
    "Access-Control-Max-Age":"86400",
    Vary:"Origin",
  };
}
function json(data,status=200,origin="",maxAge=0){
  const headers=new Headers({"Content-Type":"application/json; charset=utf-8",...corsHeaders(origin)});
  if(maxAge>0) headers.set("Cache-Control",`public, max-age=${maxAge}`);
  return new Response(JSON.stringify(data),{status,headers});
}
function stripCors(response){
  const headers=new Headers(response.headers);
  for(const k of ["Access-Control-Allow-Origin","Access-Control-Allow-Methods","Access-Control-Allow-Headers","Access-Control-Max-Age","Vary"]) headers.delete(k);
  return new Response(response.body,{status:response.status,headers});
}
function withCors(response,origin){
  const headers=new Headers(response.headers);
  for(const [k,v] of Object.entries(corsHeaders(origin))) headers.set(k,v);
  return new Response(response.body,{status:response.status,headers});
}
