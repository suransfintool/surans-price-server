const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const YA_HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ── Yahoo Finance helper ─────────────────────────────────────────
async function yf(ticker, range = '2d') {
  const bases = ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com'];
  for (const base of bases) {
    try {
      const url = `${base}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${range}`;
      const r = await axios.get(url, { headers: YA_HDR, timeout: 12000 });
      const result = r.data?.chart?.result?.[0];
      const m = result?.meta;
      if (!m || !m.regularMarketPrice) continue;
      const prev = m.previousClose || m.chartPreviousClose || m.regularMarketPrice;
      const price = m.regularMarketPrice;
      const closes = result?.indicators?.quote?.[0]?.close?.filter(v=>v!=null) || [];
      return {
        price, prev,
        change: +(price - prev).toFixed(2),
        changePct: prev > 0 ? +((price - prev) / prev * 100).toFixed(3) : 0,
        high: m.regularMarketDayHigh || price,
        low: m.regularMarketDayLow || price,
        open: m.regularMarketOpen || price,
        volume: m.regularMarketVolume || 0,
        fiftyTwoWeekHigh: m.fiftyTwoWeekHigh || price,
        fiftyTwoWeekLow: m.fiftyTwoWeekLow || price,
        name: m.shortName || m.longName || ticker,
        currency: m.currency || 'INR',
        symbol: ticker,
        closes: closes.slice(-30),
      };
    } catch(e) { continue; }
  }
  return null;
}

// ── Cache ────────────────────────────────────────────────────────
let goldCache = { ibja: 0, fetchedAt: 0 };
let mktCache  = { data: null, fetchedAt: 0 };
let nseCache  = { data: null, fetchedAt: 0, cookie: '' };
const MKT_TTL = 5 * 60 * 1000;
const NSE_TTL = 30 * 60 * 1000;

// ── Get NSE cookie (reuse within 30 min) ─────────────────────────
async function getNSECookie() {
  if (nseCache.cookie && Date.now() - nseCache.fetchedAt < NSE_TTL) {
    return nseCache.cookie;
  }
  try {
    // Step 1: Hit homepage to get initial cookies
    const r1 = await axios.get('https://www.nseindia.com', {
      headers: {
        'User-Agent': YA_HDR['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      timeout: 12000,
      maxRedirects: 5,
    });
    let cookies = (r1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    // Step 2: Hit the FII/DII page to establish session
    await new Promise(r => setTimeout(r, 800));
    try {
      const r2 = await axios.get('https://www.nseindia.com/market-data/fii-dii-activity', {
        headers: {
          'User-Agent': YA_HDR['User-Agent'],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Referer': 'https://www.nseindia.com',
          'Cookie': cookies,
        },
        timeout: 10000,
        maxRedirects: 3,
      });
      const moreCookies = (r2.headers['set-cookie'] || []).map(c => c.split(';')[0]);
      if (moreCookies.length) cookies = cookies + '; ' + moreCookies.join('; ');
    } catch(e2) { /* ignore */ }

    nseCache.cookie = cookies;
    nseCache.fetchedAt = Date.now();
    console.log('NSE cookie obtained, length:', cookies.length);
    return cookies;
  } catch(e) {
    console.log('NSE cookie failed:', e.message);
    return '';
  }
}

async function nseGet(path) {
  const cookie = await getNSECookie();
  const r = await axios.get(`https://www.nseindia.com${path}`, {
    headers: {
      'User-Agent': YA_HDR['User-Agent'],
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': 'https://www.nseindia.com/market-data/fii-dii-activity',
      'Origin': 'https://www.nseindia.com',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Cookie': cookie,
      'X-Requested-With': 'XMLHttpRequest',
    },
    timeout: 15000,
  });
  return r.data;
}

// ── GOLD ─────────────────────────────────────────────────────────
app.get('/gold', async (req, res) => {
  if (goldCache.ibja > 0 && Date.now() - goldCache.fetchedAt < 10 * 60 * 1000) {
    return res.json({ ibja: goldCache.ibja, aura: +(goldCache.ibja * 1.022).toFixed(2), per10g: goldCache.ibja * 10, source: 'cached' });
  }
  // Try ibjarates
  try {
    const r = await axios.get('https://ibjarates.com/', {
      headers: { 'User-Agent': YA_HDR['User-Agent'], 'Accept': 'text/html' }, timeout: 10000
    });
    const m = r.data.match(/999[^<]{0,80}?(\d{4,6})\s*(?:\(1 Gram\)|\/gram|per gram)/i)
           || r.data.match(/<td[^>]*>\s*999\s*<\/td>\s*<td[^>]*>\s*([\d,]+)/i);
    if (m) {
      const rate = parseFloat(m[1].replace(/,/g,''));
      if (rate > 8000 && rate < 30000) {
        goldCache = { ibja: rate, source: 'ibjarates.com', fetchedAt: Date.now() };
        return res.json({ ibja: rate, aura: +(rate*1.022).toFixed(2), per10g: rate*10, source: 'ibjarates.com' });
      }
    }
  } catch(e) {}
  // Fallback: Yahoo gold + USD/INR
  try {
    const [g, fx] = await Promise.all([yf('GC=F'), yf('USDINR=X')]);
    if (g?.price) {
      const rate = Math.round(g.price * (fx?.price || 84) * 0.03215);
      goldCache = { ibja: rate, source: 'Yahoo+FX', fetchedAt: Date.now() };
      return res.json({ ibja: rate, per10g: rate * 10, source: 'Yahoo+FX' });
    }
  } catch(e) {}
  res.status(500).json({ error: 'Gold unavailable' });
});

// ── NSE single stock / SGB / index ───────────────────────────────
app.get('/nse/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const isSGB = sym.startsWith('SGB') || sym.includes('SGBDE') || sym.includes('SGBJUL') || sym.includes('SGBMAR') || sym.includes('SGBAUG');

  if (isSGB) {
    // For SGB bonds, NSE API is more reliable than Yahoo
    try {
      const data = await nseGet(`/api/quote-equity?symbol=${encodeURIComponent(sym)}`);
      const price = data?.priceInfo?.lastPrice || data?.priceInfo?.close;
      if (price > 0) {
        console.log(`SGB ${sym} via NSE API: ₹${price}`);
        return res.json({ symbol: sym, price, change: data?.priceInfo?.change||0, changePct: data?.priceInfo?.pChange||0, source: 'NSE' });
      }
    } catch(e) { console.log(`SGB NSE failed for ${sym}:`, e.message); }

    // SGB fallback: compute from gold price
    try {
      if (goldCache.ibja > 0) {
        const goldPrice = goldCache.ibja;
        console.log(`SGB ${sym} using gold proxy: ₹${goldPrice}`);
        return res.json({ symbol: sym, price: goldPrice, source: 'GoldProxy', note: 'Based on IBJA gold rate' });
      }
    } catch(e) {}
  }

  // Regular stocks: Yahoo first
  for (const fmt of [`${sym}.NS`, sym, `${sym}.BO`]) {
    const d = await yf(fmt);
    if (d?.price > 0) return res.json({ symbol: sym, price: d.price, change: d.change, changePct: d.changePct, source: 'Yahoo' });
  }

  // Fallback: NSE API
  try {
    const data = await nseGet(`/api/quote-equity?symbol=${encodeURIComponent(sym)}`);
    const price = data?.priceInfo?.lastPrice;
    if (price > 0) return res.json({ symbol: sym, price, source: 'NSE' });
  } catch(e) {}

  res.status(404).json({ symbol: sym, price: null, error: 'Not found' });
});

// ── US stocks ────────────────────────────────────────────────────
app.get('/us/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const d = await yf(sym);
  if (d?.price > 0) return res.json({ symbol: sym, price: d.price, source: 'Yahoo' });
  res.status(404).json({ symbol: sym, price: null, error: 'Not found' });
});

// ── Batch ────────────────────────────────────────────────────────
app.get('/batch', async (req, res) => {
  const { symbols, type } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });
  const list = symbols.split(',').map(s => s.trim().toUpperCase());
  const results = {};
  await Promise.all(list.map(async sym => {
    const ticker = type === 'IN' ? sym + '.NS' : sym;
    const d = await yf(ticker);
    if (d?.price > 0) results[sym] = d.price;
  }));
  res.json(results);
});

// ══════════════════════════════════════════════════════════════════
// ── MARKET DATA — Complete endpoint ──────────────────────────────
// ══════════════════════════════════════════════════════════════════
app.get('/marketdata', async (req, res) => {
  const force = req.query.force === '1';
  if (!force && mktCache.data && Date.now() - mktCache.fetchedAt < MKT_TTL) {
    return res.json({ ...mktCache.data, cached: true });
  }

  console.log('Fetching fresh market data...');

  // ── Parallel Yahoo fetches ──────────────────────────────────────
  const [
    nifty50, bankNifty, midcap, smallcap, sensex,
    niftyIT, niftyPharma, niftyFMCG, niftyAuto, niftyMetal, niftyRealty, niftyEnergy,
    indiaVIX, giftNifty,
    sp500, nasdaq, dow, ftse, hangseng, nikkei, dax,
    crude, gold, silver, naturalGas,
    usdinr, eurinr, jpyinr, gbpinr, aedinr,
    niftyHist
  ] = await Promise.allSettled([
    // FIX: ^CNXMIDCAP was wrong — correct Yahoo ticker for Nifty Midcap 100
    yf('^NSEI'), yf('^NSEBANK'), yf('^CNXMIDCAP150'), yf('^CNXSMALL'), yf('^BSESN'),
    yf('^CNXIT'), yf('^CNXPHARMA'), yf('^CNXFMCG'), yf('^CNXAUTO'), yf('^CNXMETAL'),
    yf('^CNXREALTY'), yf('^CNXENERGY'),
    yf('^INDIAVIX'),
    // FIX: GIFT Nifty — try multiple tickers
    yf('^NSEI'), // fallback: same as NIFTY for now, GIFT not on Yahoo
    // Global — in their OWN currency (USD, GBP, HKD, JPY, EUR)
    yf('^GSPC'), yf('^IXIC'), yf('^DJI'), yf('^FTSE'),
    yf('^HSI'), yf('^N225'), yf('^GDAXI'),
    // Commodities in USD
    yf('CL=F'), yf('GC=F'), yf('SI=F'), yf('NG=F'),
    // Currencies (value of 1 unit in INR)
    yf('USDINR=X'), yf('EURINR=X'), yf('JPYINR=X'), yf('GBPINR=X'), yf('AEDINR=X'),
    // NIFTY 30-day history
    yf('^NSEI', '1mo'),
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

  // USD/INR most accurate
  let usdInrRate = usdinr?.price || 84;
  try {
    const fx = await axios.get('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', { timeout: 6000 });
    if (fx.data?.usd?.inr) usdInrRate = +fx.data.usd.inr.toFixed(2);
  } catch(e) {}

  // Gold INR
  let goldInr = goldCache.ibja > 0 ? goldCache.ibja :
    (gold?.price ? Math.round(gold.price * usdInrRate * 0.03215) : null);

  // ── NSE data (FII/DII + NIFTY 50 stocks) ────────────────────────
  let fiiNet=null,fiiB=null,fiiS=null,diiNet=null,diiB=null,diiS=null,fiiHistory=[];
  let nifty50Stocks=[],adv=0,dec=0,unc=0,topGainers=[],topLosers=[];

  // FII/DII — try multiple NSE endpoints with proper headers
  try {
    // Try 1: fiidiiTradeReact
    const fiiData = await nseGet('/api/fiidiiTradeReact');
    if (fiiData?.length && parseFloat(fiiData[0]?.NET_VALUE_FII||0) !== 0) {
      const t = fiiData[0];
      fiiNet = +parseFloat(t.NET_VALUE_FII||0).toFixed(2);
      fiiB   = +parseFloat(t.BUY_VALUE_FII||0).toFixed(2);
      fiiS   = +parseFloat(t.SELL_VALUE_FII||0).toFixed(2);
      diiNet = +parseFloat(t.NET_VALUE_DII||0).toFixed(2);
      diiB   = +parseFloat(t.BUY_VALUE_DII||0).toFixed(2);
      diiS   = +parseFloat(t.SELL_VALUE_DII||0).toFixed(2);
      fiiHistory = fiiData.slice(0,7).map(r=>({
        date: r.date||r.DATE||r.tradeDate||'',
        fii: +parseFloat(r.NET_VALUE_FII||0).toFixed(2),
        dii: +parseFloat(r.NET_VALUE_DII||0).toFixed(2)
      }));
      console.log('FII OK via fiidiiTradeReact, net:', fiiNet);
    } else {
      throw new Error('Zero or empty FII data');
    }
  } catch(e1) {
    console.log('FII attempt 1 failed:', e1.message, '— trying alt endpoint');
    try {
      // Try 2: fiiDiiData endpoint (alternate NSE path)
      const fiiData2 = await nseGet('/api/fiiDiiData');
      if (fiiData2?.length && parseFloat(fiiData2[0]?.netPurchasesSalesCrore||0) !== 0) {
        const t = fiiData2[0];
        fiiNet = +parseFloat(t.netPurchasesSalesCrore||0).toFixed(2);
        fiiB   = +parseFloat(t.totalPurchasesCrore||0).toFixed(2);
        fiiS   = +parseFloat(t.totalSalesCrore||0).toFixed(2);
        const d2 = fiiData2[1];
        if (d2) {
          diiNet = +parseFloat(d2.netPurchasesSalesCrore||0).toFixed(2);
          diiB   = +parseFloat(d2.totalPurchasesCrore||0).toFixed(2);
          diiS   = +parseFloat(d2.totalSalesCrore||0).toFixed(2);
        }
        console.log('FII OK via fiiDiiData, net:', fiiNet);
      } else {
        throw new Error('Zero or empty FII data alt');
      }
    } catch(e2) {
      console.log('FII attempt 2 failed:', e2.message, '— using cached FII if available');
      // Use cached FII data from previous successful fetch
      if (mktCache.data?.fiiNet && mktCache.data.fiiNet !== 0) {
        fiiNet = mktCache.data.fiiNet;
        fiiB   = mktCache.data.fiiB;
        fiiS   = mktCache.data.fiiS;
        diiNet = mktCache.data.diiNet;
        diiB   = mktCache.data.diiB;
        diiS   = mktCache.data.diiS;
        fiiHistory = mktCache.data.fiiHistory || [];
        console.log('Using cached FII data:', fiiNet);
      } else {
        fiiNet = null; // explicitly null = not available
        console.log('FII unavailable — will show "after 5PM" message');
      }
    }
  }

  try {
    const nseData = await nseGet('/api/equity-stockIndices?index=NIFTY%2050');
    const stocks = (nseData?.data||[]).filter(s=>s.symbol!=='NIFTY 50');
    nifty50Stocks = stocks.map(s=>({
      symbol:s.symbol, price:s.lastPrice, chgPct:s.pChange,
      chg:s.change, high:s.dayHigh, low:s.dayLow,
      open:s.open, prev:s.previousClose,
      mcap: s.totalMarketCap||s.ffmc||0
    }));
    stocks.forEach(s=>{ if(s.pChange>0)adv++; else if(s.pChange<0)dec++; else unc++; });
    topGainers = [...nifty50Stocks].sort((a,b)=>b.chgPct-a.chgPct).slice(0,5);
    topLosers  = [...nifty50Stocks].sort((a,b)=>a.chgPct-b.chgPct).slice(0,5);
    console.log('NSE stocks OK:', nifty50Stocks.length, 'stocks');
  } catch(e) { console.log('NSE stocks failed:', e.message); }

  // ── MMI calculation ──────────────────────────────────────────────
  let mmi = 50;
  const n50 = nifty50;
  if (n50?.price && n50.fiftyTwoWeekLow && n50.fiftyTwoWeekHigh) {
    const range = n50.fiftyTwoWeekHigh - n50.fiftyTwoWeekLow;
    if (range > 0) mmi = ((n50.price - n50.fiftyTwoWeekLow) / range) * 100;
  }
  const vix = indiaVIX?.price || 0;
  if (vix > 0) { const vs=vix<12?85:vix<16?70:vix<20?50:vix<25?30:15; mmi=(mmi+vs)/2; }
  if (fiiNet!==null) { const fs=fiiNet>2000?80:fiiNet>0?62:fiiNet>-2000?40:20; mmi=(mmi*2+fs)/3; }
  if (adv+dec>0) { const as=(adv/(adv+dec))*100; mmi=(mmi*3+as)/4; }
  mmi = Math.max(0,Math.min(100,Math.round(mmi)));
  const mmiLabel = mmi>=70?'Extreme Greed':mmi>=55?'Greed':mmi>=45?'Neutral':mmi>=30?'Fear':'Extreme Fear';
  const mmiColor = mmi>=70?'#00c853':mmi>=55?'#76d275':mmi>=45?'#ffba00':mmi>=30?'#ff6f00':'#f44336';

  const data = {
    ts: Date.now(),
    // Indian indices
    nifty50, bankNifty,
    midcap: midcap||null,   // FIX: ensure null if not fetched
    smallcap, sensex,
    niftyIT, niftyPharma, niftyFMCG, niftyAuto, niftyMetal, niftyRealty, niftyEnergy,
    indiaVIX,
    // GIFT Nifty — use pre-open data from NSE if available
    giftNifty: null, // Will be populated separately if NSE provides it
    // Global (native currencies)
    sp500: sp500 ? {...sp500, displayCurrency:'USD'} : null,
    nasdaq: nasdaq ? {...nasdaq, displayCurrency:'USD'} : null,
    dow: dow ? {...dow, displayCurrency:'USD'} : null,
    ftse: ftse ? {...ftse, displayCurrency:'GBP'} : null,
    hangseng: hangseng ? {...hangseng, displayCurrency:'HKD'} : null,
    nikkei: nikkei ? {...nikkei, displayCurrency:'JPY'} : null,
    dax: dax ? {...dax, displayCurrency:'EUR'} : null,
    // Commodities
    crude, gold, silver, naturalGas,
    // FX
    usdinr, eurinr, jpyinr, gbpinr, aedinr, usdInrRate,
    // FII/DII
    fiiNet, fiiB, fiiS, diiNet, diiB, diiS, fiiHistory,
    // Breadth
    adv, dec, unc, nifty50Stocks, topGainers, topLosers,
    // Mood
    mmi, mmiLabel, mmiColor,
    // History for sparkline
    niftyCloses: niftyHist?.closes || [],
  };

  // Try to get GIFT Nifty from NSE pre-open
  try {
    const preOpen = await nseGet('/api/market-data-pre-open?key=NIFTY');
    const giftPrice = preOpen?.data?.find(d=>d.metadata?.symbol==='NIFTY')?.metadata?.lastPrice;
    if (giftPrice) data.giftNifty = { price: giftPrice, changePct: 0, change: 0, symbol: 'GIFT NIFTY' };
  } catch(e) {}

  mktCache = { data, fetchedAt: Date.now() };
  console.log('Market data ready. NIFTY:', n50?.price, 'Midcap:', midcap?.price, 'FII:', fiiNet);
  res.json(data);
});

// ── Health ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'Surans Price Server v3.3',
    endpoints: ['/gold','/nse/:symbol','/us/:symbol','/batch','/marketdata'],
    cacheAge: mktCache.data ? Math.round((Date.now()-mktCache.fetchedAt)/1000)+'s' : 'empty',
    goldCache: goldCache.ibja > 0 ? '₹'+goldCache.ibja+'/g' : 'none',
    nseLastCookie: nseCache.cookie ? 'yes ('+Math.round((Date.now()-nseCache.fetchedAt)/60000)+'m ago)' : 'none',
  });
});

app.listen(PORT, () => console.log('Price server v3.1 on port', PORT));
