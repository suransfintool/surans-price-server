const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// CORS — allow all origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ── Shared Yahoo Finance fetcher ─────────────────────────────────
const YA_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' };

async function yahooQuote(ticker, range = '2d') {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${range}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${range}`,
  ];
  for (const url of urls) {
    try {
      const r = await axios.get(url, { headers: YA_HEADERS, timeout: 10000 });
      const result = r.data?.chart?.result?.[0];
      const m = result?.meta;
      if (!m) continue;
      const prev = m.previousClose || m.chartPreviousClose || 0;
      const price = m.regularMarketPrice || prev;
      const closes = result?.indicators?.quote?.[0]?.close?.filter(Boolean) || [];
      return {
        price, prev,
        change: price - prev,
        changePct: prev > 0 ? (price - prev) / prev * 100 : 0,
        high: m.regularMarketDayHigh,
        low: m.regularMarketDayLow,
        open: m.regularMarketOpen,
        volume: m.regularMarketVolume,
        fiftyTwoWeekHigh: m.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: m.fiftyTwoWeekLow,
        name: m.shortName || m.longName || ticker,
        symbol: ticker,
        closes: closes.slice(-30),
      };
    } catch (e) {}
  }
  return null;
}

// ── CACHE ────────────────────────────────────────────────────────
let goldCache = { ibja: 0, fetchedAt: 0 };
let mktCache = { data: null, fetchedAt: 0 };
const MKT_TTL = 5 * 60 * 1000; // 5 min cache

// ── GOLD ─────────────────────────────────────────────────────────
app.get('/gold', async (req, res) => {
  if (goldCache.ibja > 0 && Date.now() - goldCache.fetchedAt < 10 * 60 * 1000) {
    return res.json({ ibja: goldCache.ibja, aura: +(goldCache.ibja * 1.022).toFixed(2), per10g: goldCache.ibja * 10, source: goldCache.source + ' (cached)' });
  }
  const headers = { 'User-Agent': YA_HEADERS['User-Agent'], 'Accept': 'text/html', 'Referer': 'https://www.google.com/' };
  // Source 1: ibjarates.com
  try {
    const r = await axios.get('https://ibjarates.com/', { headers, timeout: 10000 });
    const m = r.data.match(/999 Purity[\s\S]{0,200}?(\d{4,6})\s*\(1 Gram\)/i)
           || r.data.match(/<h3[^>]*>\s*(\d{4,6})\s*<\/h3>/);
    if (m) {
      const rate = parseFloat(m[1]);
      if (rate > 8000 && rate < 30000) {
        goldCache = { ibja: rate, source: 'ibjarates.com', fetchedAt: Date.now() };
        return res.json({ ibja: rate, aura: +(rate * 1.022).toFixed(2), per10g: rate * 10, source: 'ibjarates.com' });
      }
    }
  } catch(e) {}
  // Source 2: Yahoo gold
  try {
    const g = await yahooQuote('GC=F');
    if (g?.price) {
      const usdInr = await yahooQuote('USDINR=X');
      const rate = g.price * (usdInr?.price || 84) * 0.03215;
      goldCache = { ibja: Math.round(rate), source: 'Yahoo+FX', fetchedAt: Date.now() };
      return res.json({ ibja: Math.round(rate), per10g: Math.round(rate) * 10, source: 'Yahoo+FX' });
    }
  } catch(e) {}
  res.status(500).json({ error: 'Gold price unavailable' });
});

// ── NSE single stock ─────────────────────────────────────────────
app.get('/nse/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  // Try Yahoo Finance with .NS suffix
  const d = await yahooQuote(symbol + '.NS');
  if (d?.price) return res.json({ symbol, price: d.price, source: 'Yahoo' });
  // Try without suffix (indices like ^NSEI)
  const d2 = await yahooQuote(symbol);
  if (d2?.price) return res.json({ symbol, price: d2.price, source: 'Yahoo' });
  res.status(404).json({ symbol, price: null, error: 'Not found' });
});

// ── US stocks ────────────────────────────────────────────────────
app.get('/us/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const d = await yahooQuote(symbol);
  if (d?.price) return res.json({ symbol, price: d.price, source: 'Yahoo' });
  res.status(404).json({ symbol, price: null, error: 'Not found' });
});

// ── Batch ─────────────────────────────────────────────────────────
app.get('/batch', async (req, res) => {
  const { symbols, type } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });
  const list = symbols.split(',').map(s => s.trim().toUpperCase());
  const results = {};
  await Promise.all(list.map(async sym => {
    const ticker = type === 'IN' ? sym + '.NS' : sym;
    const d = await yahooQuote(ticker);
    if (d?.price) results[sym] = d.price;
  }));
  res.json(results);
});

// ══════════════════════════════════════════════════════════════════
// ── MARKET DATA — Full Stonkzz-style endpoint ─────────────────────
// All fetched server-side to bypass CORS
// ══════════════════════════════════════════════════════════════════
app.get('/marketdata', async (req, res) => {
  // Use cache if fresh
  if (mktCache.data && Date.now() - mktCache.fetchedAt < MKT_TTL) {
    return res.json({ ...mktCache.data, cached: true, cacheAge: Math.round((Date.now() - mktCache.fetchedAt) / 1000) });
  }

  // Fetch all in parallel
  const [
    nifty50, bankNifty, midcap, smallcap, sensex,
    niftyIT, niftyPharma, niftyFMCG, niftyAuto, niftyMetal, niftyRealty, niftyEnergy,
    indiaVIX, giftNifty,
    sp500, nasdaq, dow, ftse, hangseng, nikkei, dax,
    crude, gold, silver, naturalGas,
    usdinr, eurinr, jpyinr, gbpinr
  ] = await Promise.all([
    yahooQuote('^NSEI'), yahooQuote('^NSEBANK'), yahooQuote('^CNXMIDCAP'), yahooQuote('^CNXSMALL'), yahooQuote('^BSESN'),
    yahooQuote('^CNXIT'), yahooQuote('^CNXPHARMA'), yahooQuote('^CNXFMCG'), yahooQuote('^CNXAUTO'), yahooQuote('^CNXMETAL'),
    yahooQuote('^CNXREALTY'), yahooQuote('^CNXENERGY'),
    yahooQuote('^INDIAVIX'), yahooQuote('NF=F'),
    yahooQuote('^GSPC'), yahooQuote('^IXIC'), yahooQuote('^DJI'), yahooQuote('^FTSE'),
    yahooQuote('^HSI'), yahooQuote('^N225'), yahooQuote('^GDAXI'),
    yahooQuote('CL=F'), yahooQuote('GC=F'), yahooQuote('SI=F'), yahooQuote('NG=F'),
    yahooQuote('USDINR=X'), yahooQuote('EURINR=X'), yahooQuote('JPYINR=X'), yahooQuote('GBPINR=X')
  ]);

  // NIFTY 30-day history
  const niftyHistory = await yahooQuote('^NSEI', '1mo');

  // USD/INR from fawazahmed (most accurate free source)
  let usdInrRate = usdinr?.price || 84;
  try {
    const fx = await axios.get('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', { timeout: 5000 });
    if (fx.data?.usd?.inr) usdInrRate = fx.data.usd.inr;
  } catch(e) {}

  // Gold INR price
  let goldInr = null;
  if (goldCache.ibja > 0) {
    goldInr = goldCache.ibja;
  } else if (gold?.price) {
    goldInr = Math.round(gold.price * usdInrRate * 0.03215);
  }

  // FII/DII — NSE public API (server-side bypasses CORS)
  let fiiNet=null, fiiB=null, fiiS=null, diiNet=null, diiB=null, diiS=null, fiiHistory=[];
  try {
    // First get NSE cookie
    const cookieR = await axios.get('https://www.nseindia.com', {
      headers: { 'User-Agent': YA_HEADERS['User-Agent'], 'Accept': 'text/html' },
      timeout: 8000
    });
    const cookie = cookieR.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ') || '';
    const fiiR = await axios.get('https://www.nseindia.com/api/fiidiiTradeReact', {
      headers: { 'User-Agent': YA_HEADERS['User-Agent'], 'Accept': 'application/json', 'Referer': 'https://www.nseindia.com', 'Cookie': cookie },
      timeout: 8000
    });
    if (fiiR.data?.length) {
      const t = fiiR.data[0];
      fiiNet = parseFloat(t.NET_VALUE_FII) || 0;
      fiiB   = parseFloat(t.BUY_VALUE_FII) || 0;
      fiiS   = parseFloat(t.SELL_VALUE_FII) || 0;
      diiNet = parseFloat(t.NET_VALUE_DII) || 0;
      diiB   = parseFloat(t.BUY_VALUE_DII) || 0;
      diiS   = parseFloat(t.SELL_VALUE_DII) || 0;
      fiiHistory = fiiR.data.slice(0, 7).map(row => ({
        date: row.date || row.DATE || '',
        fii: parseFloat(row.NET_VALUE_FII) || 0,
        dii: parseFloat(row.NET_VALUE_DII) || 0
      }));
    }
  } catch(e) { console.log('FII fetch failed:', e.message); }

  // NIFTY 50 stock list (for heatmap + gainers/losers + A/D)
  let nifty50Stocks=[], adv=0, dec=0, unc=0, topGainers=[], topLosers=[];
  try {
    const cookieR2 = await axios.get('https://www.nseindia.com', {
      headers: { 'User-Agent': YA_HEADERS['User-Agent'], 'Accept': 'text/html' }, timeout: 8000
    });
    const cookie2 = cookieR2.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ') || '';
    const nseR = await axios.get('https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050', {
      headers: { 'User-Agent': YA_HEADERS['User-Agent'], 'Accept': 'application/json', 'Referer': 'https://www.nseindia.com', 'Cookie': cookie2 },
      timeout: 10000
    });
    const stocks = (nseR.data?.data || []).filter(s => s.symbol !== 'NIFTY 50');
    nifty50Stocks = stocks.map(s => ({
      symbol: s.symbol, price: s.lastPrice, chgPct: s.pChange,
      chg: s.change, high: s.dayHigh, low: s.dayLow,
      open: s.open, prev: s.previousClose, volume: s.totalTradedVolume,
      mcap: s.totalMarketCap || s.ffmc || 0
    }));
    stocks.forEach(s => { if (s.pChange > 0) adv++; else if (s.pChange < 0) dec++; else unc++; });
    topGainers = [...nifty50Stocks].sort((a,b) => b.chgPct - a.chgPct).slice(0, 5);
    topLosers  = [...nifty50Stocks].sort((a,b) => a.chgPct - b.chgPct).slice(0, 5);
  } catch(e) { console.log('NSE stocks failed:', e.message); }

  // Market Mood Index calculation
  let mmi = 50;
  if (nifty50?.price && nifty50.fiftyTwoWeekLow && nifty50.fiftyTwoWeekHigh) {
    const range = nifty50.fiftyTwoWeekHigh - nifty50.fiftyTwoWeekLow;
    if (range > 0) mmi = ((nifty50.price - nifty50.fiftyTwoWeekLow) / range) * 100;
  }
  const vixVal = indiaVIX?.price || 0;
  if (vixVal > 0) { const vs = vixVal<12?85:vixVal<16?70:vixVal<20?50:vixVal<25?30:15; mmi = (mmi + vs) / 2; }
  if (fiiNet !== null) { const fs = fiiNet>2000?80:fiiNet>0?62:fiiNet>-2000?40:20; mmi = (mmi * 2 + fs) / 3; }
  if (adv + dec > 0) { const as = (adv / (adv + dec)) * 100; mmi = (mmi * 3 + as) / 4; }
  mmi = Math.max(0, Math.min(100, Math.round(mmi)));
  const mmiLabel = mmi>=70?'Extreme Greed':mmi>=55?'Greed':mmi>=45?'Neutral':mmi>=30?'Fear':'Extreme Fear';
  const mmiColor = mmi>=70?'#00c853':mmi>=55?'#76d275':mmi>=45?'#ffba00':mmi>=30?'#ff6f00':'#f44336';

  const data = {
    ts: Date.now(),
    // Indian indices
    nifty50, bankNifty, midcap, smallcap, sensex,
    // Sectoral
    niftyIT, niftyPharma, niftyFMCG, niftyAuto, niftyMetal, niftyRealty, niftyEnergy,
    // VIX + GIFT
    indiaVIX, giftNifty,
    // Global
    sp500, nasdaq, dow, ftse, hangseng, nikkei, dax,
    // Commodities
    crude, gold, silver, naturalGas,
    // Currency
    usdinr, eurinr, jpyinr, gbpinr, usdInrRate,
    // FII/DII
    fiiNet, fiiB, fiiS, diiNet, diiB, diiS, fiiHistory,
    // Breadth + Heatmap
    adv, dec, unc, nifty50Stocks, topGainers, topLosers,
    // Mood
    mmi, mmiLabel, mmiColor,
    // History
    niftyCloses: niftyHistory?.closes || []
  };

  mktCache = { data, fetchedAt: Date.now() };
  res.json(data);
});

// ── Health check ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'Surans Price Server v3.0',
    endpoints: ['/gold', '/nse/:symbol', '/us/:symbol', '/batch', '/marketdata'],
    marketDataCached: mktCache.data ? `Yes (${Math.round((Date.now()-mktCache.fetchedAt)/1000)}s ago)` : 'No',
    goldCache: goldCache.ibja > 0 ? `₹${goldCache.ibja}/g` : 'Not fetched'
  });
});

app.listen(PORT, () => console.log(`Price server v3.0 running on port ${PORT}`));
