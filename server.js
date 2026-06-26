const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ── Yahoo Finance fetch ──────────────────────────────────────────
const YA_HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function yf(ticker, range = '2d') {
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await axios.get(
        `${base}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${range}`,
        { headers: YA_HDR, timeout: 12000 }
      );
      const result = r.data?.chart?.result?.[0];
      const m = result?.meta;
      if (!m?.regularMarketPrice) continue;
      const prev = m.previousClose || m.chartPreviousClose || m.regularMarketPrice;
      const price = m.regularMarketPrice;
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
        closes: (result?.indicators?.quote?.[0]?.close || []).filter(v => v != null).slice(-30),
      };
    } catch(e) { continue; }
  }
  return null;
}

// ── Caches ───────────────────────────────────────────────────────
let goldCache = { ibja: 0, fetchedAt: 0 };
let mktCache  = { data: null, fetchedAt: 0 };
const MKT_TTL = 5 * 60 * 1000;

// ── NSE cookie helper (best-effort) ─────────────────────────────
let nseSession = { cookie: '', fetchedAt: 0 };
async function getNSECookie() {
  if (nseSession.cookie && Date.now() - nseSession.fetchedAt < 20 * 60 * 1000) {
    return nseSession.cookie;
  }
  try {
    const r1 = await axios.get('https://www.nseindia.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
      },
      timeout: 15000, maxRedirects: 5,
    });
    let cookies = (r1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    // Wait then hit a data page to fully establish session
    await new Promise(r => setTimeout(r, 1200));
    try {
      const r2 = await axios.get('https://www.nseindia.com/market-data/fii-dii-activity', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Referer': 'https://www.nseindia.com/',
          'Cookie': cookies,
        },
        timeout: 12000, maxRedirects: 3,
      });
      const c2 = (r2.headers['set-cookie'] || []).map(c => c.split(';')[0]);
      if (c2.length) cookies += '; ' + c2.join('; ');
    } catch(e) {}
    nseSession = { cookie: cookies, fetchedAt: Date.now() };
    console.log(`NSE cookie OK (${cookies.length} chars)`);
    return cookies;
  } catch(e) {
    console.log('NSE cookie failed:', e.message);
    return '';
  }
}

async function nseAPI(path, referer) {
  const cookie = await getNSECookie();
  const r = await axios.get(`https://www.nseindia.com${path}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-IN,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': referer || 'https://www.nseindia.com/',
      'Origin': 'https://www.nseindia.com',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Cookie': cookie,
    },
    timeout: 15000,
  });
  return r.data;
}

// ── GOLD ─────────────────────────────────────────────────────────
async function fetchGoldRate() {
  // Source 1: ibjarates.com
  try {
    const r = await axios.get('https://ibjarates.com/', {
      headers: { 'User-Agent': YA_HDR['User-Agent'], 'Accept': 'text/html', 'Accept-Language': 'en-IN' },
      timeout: 10000,
    });
    const html = r.data;
    // Try multiple patterns
    const patterns = [
      /999[\s\S]{0,100}?<\/td>[\s\S]{0,50}?<td[^>]*>([\d,]+)/i,
      /([\d,]+)<\/td>[\s\S]{0,50}?Fine Gold 999/i,
      /24K[^<]*<[^>]+>([\d,]+)/i,
      /999\.9[^<]*<[^>]+>([\d,]+)/i,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) {
        const rate = parseFloat(m[1].replace(/,/g, ''));
        if (rate > 8000 && rate < 35000) {
          goldCache = { ibja: rate, source: 'ibjarates', fetchedAt: Date.now() };
          console.log(`Gold from ibjarates: ₹${rate}`);
          return rate;
        }
      }
    }
  } catch(e) { console.log('ibjarates failed:', e.message); }

  // Source 2: Yahoo GC=F + USD/INR
  try {
    const [g, fx] = await Promise.all([yf('GC=F'), yf('USDINR=X')]);
    if (g?.price && g.price > 1000) {
      const usd = fx?.price || 84;
      // Troy oz to grams: 1 troy oz = 31.1035g, 1g = 1/31.1035 oz
      const rate = Math.round(g.price * usd / 31.1035);
      goldCache = { ibja: rate, source: 'Yahoo+FX', fetchedAt: Date.now() };
      console.log(`Gold from Yahoo: $${g.price} × ₹${usd} / 31.1 = ₹${rate}/g`);
      return rate;
    }
  } catch(e) { console.log('Yahoo gold failed:', e.message); }

  // Source 3: goldapi.io (free tier - no key needed for basic)
  try {
    const r = await axios.get('https://data-asg.goldprice.org/dbXRates/USD', {
      headers: { 'User-Agent': YA_HDR['User-Agent'] }, timeout: 8000,
    });
    const priceOz = r.data?.items?.[0]?.xauPrice;
    const usdInr = r.data?.items?.[0]?.exch?.INR;
    if (priceOz && usdInr) {
      const rate = Math.round(priceOz * usdInr / 31.1035);
      goldCache = { ibja: rate, source: 'goldprice.org', fetchedAt: Date.now() };
      console.log(`Gold from goldprice.org: ₹${rate}/g`);
      return rate;
    }
  } catch(e) {}

  return goldCache.ibja > 0 ? goldCache.ibja : null;
}

app.get('/gold', async (req, res) => {
  if (goldCache.ibja > 0 && Date.now() - goldCache.fetchedAt < 10 * 60 * 1000) {
    return res.json({ ibja: goldCache.ibja, aura: +(goldCache.ibja * 1.022).toFixed(2), per10g: goldCache.ibja * 10, source: 'cached' });
  }
  const rate = await fetchGoldRate();
  if (rate) {
    return res.json({ ibja: rate, aura: +(rate * 1.022).toFixed(2), per10g: rate * 10, source: goldCache.source });
  }
  res.status(500).json({ error: 'Gold price unavailable from all sources' });
});

// ── NSE / SGB single quote ───────────────────────────────────────
app.get('/nse/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const isSGB = /SGB[A-Z0-9]/.test(sym);

  if (isSGB) {
    // Attempt 1: NSE equity quote API with the CORRECT referer (NSE checks this)
    try {
      const data = await nseAPI(
        `/api/quote-equity?symbol=${encodeURIComponent(sym)}`,
        `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(sym)}`
      );
      const price = data?.priceInfo?.lastPrice || data?.priceInfo?.close;
      if (price > 0) {
        console.log(`SGB ${sym} from NSE equity API: ₹${price}`);
        return res.json({ symbol: sym, price, change: data?.priceInfo?.change || 0, changePct: data?.priceInfo?.pChange || 0, source: 'NSE', isLive: true });
      }
    } catch (e) { console.log(`SGB NSE equity API failed: ${e.message}`); }

    // Attempt 2: NSE bonds/securities-info API (SGBs are listed under the debt segment)
    try {
      const data2 = await nseAPI(
        `/api/quote-equity?symbol=${encodeURIComponent(sym)}&section=trade_info`,
        `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(sym)}`
      );
      const price2 = data2?.priceInfo?.lastPrice || data2?.lastPrice;
      if (price2 > 0) {
        console.log(`SGB ${sym} from NSE trade_info: ₹${price2}`);
        return res.json({ symbol: sym, price: price2, source: 'NSE', isLive: true });
      }
    } catch (e) { console.log(`SGB NSE trade_info failed: ${e.message}`); }

    // Both NSE attempts failed — DO NOT substitute gold spot rate as if it were
    // the traded SGB price. SGBs trade at a premium/discount to spot gold, so
    // gold rate ≠ SGB market price. Return clearly as unavailable instead of a
    // plausible-looking but wrong number.
    console.log(`SGB ${sym}: NSE unavailable, returning unavailable (not substituting gold rate)`);
    return res.status(503).json({
      symbol: sym,
      price: null,
      source: 'unavailable',
      reason: 'NSE_BLOCKED',
      message: 'Live NSE price unavailable right now. Showing your last saved price instead of an estimate.',
    });
  }

  // Regular stocks: Yahoo .NS → .BO → bare
  for (const ticker of [`${sym}.NS`, `${sym}.BO`, sym]) {
    const d = await yf(ticker);
    if (d?.price > 0) {
      console.log(`${sym} from Yahoo (${ticker}): ₹${d.price}`);
      return res.json({ symbol: sym, price: d.price, change: d.change, changePct: d.changePct, source: 'Yahoo' });
    }
  }

  // NSE API fallback
  try {
    const data = await nseAPI(
      `/api/quote-equity?symbol=${encodeURIComponent(sym)}`,
      `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(sym)}`
    );
    const price = data?.priceInfo?.lastPrice;
    if (price > 0) return res.json({ symbol: sym, price, source: 'NSE' });
  } catch(e) {}

  res.status(404).json({ symbol: sym, price: null, error: 'Price unavailable' });
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
// ── FULL MARKET DATA ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
app.get('/marketdata', async (req, res) => {
  if (req.query.force !== '1' && mktCache.data && Date.now() - mktCache.fetchedAt < MKT_TTL) {
    return res.json({ ...mktCache.data, cached: true });
  }
  console.log('=== Fetching fresh market data ===');

  // ── Fetch gold first so SGB can use it ─────────────────────────
  const goldRate = await fetchGoldRate();

  // ── Yahoo fetches (all parallel) ────────────────────────────────
  const [
    nifty50, bankNifty, midcap, smallcap, sensex,
    niftyIT, niftyPharma, niftyFMCG, niftyAuto, niftyMetal, niftyRealty, niftyEnergy,
    indiaVIX,
    sp500, nasdaq, dow, ftse, hangseng, nikkei, dax,
    crude, gold, silver, naturalGas,
    usdinr, eurinr, jpyinr, gbpinr, aedinr,
    niftyHist
  ] = await Promise.allSettled([
    yf('^NSEI'), yf('^NSEBANK'), yf('^CNXMIDCAP150'), yf('^CNXSMALL'), yf('^BSESN'),
    yf('^CNXIT'), yf('^CNXPHARMA'), yf('^CNXFMCG'), yf('^CNXAUTO'), yf('^CNXMETAL'),
    yf('^CNXREALTY'), yf('^CNXENERGY'), yf('^INDIAVIX'),
    yf('^GSPC'), yf('^IXIC'), yf('^DJI'), yf('^FTSE'),
    yf('^HSI'), yf('^N225'), yf('^GDAXI'),
    yf('CL=F'), yf('GC=F'), yf('SI=F'), yf('NG=F'),
    yf('USDINR=X'), yf('EURINR=X'), yf('JPYINR=X'), yf('GBPINR=X'), yf('AEDINR=X'),
    yf('^NSEI', '1mo'),
  ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : null));

  // USD/INR best rate
  let usdInrRate = usdinr?.price || 84;
  try {
    const fx = await axios.get(
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      { timeout: 6000 }
    );
    if (fx.data?.usd?.inr) usdInrRate = +fx.data.usd.inr.toFixed(2);
  } catch(e) {}

  // ── FII/DII — try NSE with proper session ───────────────────────
  let fiiNet=null, fiiB=null, fiiS=null, diiNet=null, diiB=null, diiS=null, fiiHistory=[];
  
  const tryFII = async (path, parser) => {
    try {
      const data = await nseAPI(path);
      return parser(data);
    } catch(e) {
      console.log(`FII ${path} failed: ${e.message}`);
      return null;
    }
  };

  // Attempt 1: fiidiiTradeReact
  let fiiResult = await tryFII('/api/fiidiiTradeReact', data => {
    if (!data?.length) return null;
    const t = data[0];
    const net = parseFloat(t.NET_VALUE_FII || 0);
    if (Math.abs(net) < 0.01) return null; // Reject zero
    return {
      fiiNet: +net.toFixed(2),
      fiiB: +parseFloat(t.BUY_VALUE_FII || 0).toFixed(2),
      fiiS: +parseFloat(t.SELL_VALUE_FII || 0).toFixed(2),
      diiNet: +parseFloat(t.NET_VALUE_DII || 0).toFixed(2),
      diiB: +parseFloat(t.BUY_VALUE_DII || 0).toFixed(2),
      diiS: +parseFloat(t.SELL_VALUE_DII || 0).toFixed(2),
      history: data.slice(0, 7).map(r => ({
        date: r.date || r.DATE || r.tradeDate || '',
        fii: +parseFloat(r.NET_VALUE_FII || 0).toFixed(2),
        dii: +parseFloat(r.NET_VALUE_DII || 0).toFixed(2),
      })),
    };
  });

  // Attempt 2: alternate path
  if (!fiiResult) {
    fiiResult = await tryFII('/api/fiiDiiData', data => {
      if (!data?.length) return null;
      const rows = data.filter(r => r.category === 'FII/FPI' || r.category === 'DII');
      const fii = rows.find(r => r.category === 'FII/FPI');
      const dii = rows.find(r => r.category === 'DII');
      const net = parseFloat(fii?.netPurchasesSalesCrore || 0);
      if (Math.abs(net) < 0.01) return null;
      return {
        fiiNet: +net.toFixed(2),
        fiiB: +parseFloat(fii?.totalPurchasesCrore || 0).toFixed(2),
        fiiS: +parseFloat(fii?.totalSalesCrore || 0).toFixed(2),
        diiNet: +parseFloat(dii?.netPurchasesSalesCrore || 0).toFixed(2),
        diiB: +parseFloat(dii?.totalPurchasesCrore || 0).toFixed(2),
        diiS: +parseFloat(dii?.totalSalesCrore || 0).toFixed(2),
        history: [],
      };
    });
  }

  // Use cached if all attempts fail
  if (!fiiResult && mktCache.data?.fiiNet != null && mktCache.data.fiiNet !== 0) {
    console.log('Using cached FII data:', mktCache.data.fiiNet);
    fiiResult = {
      fiiNet: mktCache.data.fiiNet, fiiB: mktCache.data.fiiB, fiiS: mktCache.data.fiiS,
      diiNet: mktCache.data.diiNet, diiB: mktCache.data.diiB, diiS: mktCache.data.diiS,
      history: mktCache.data.fiiHistory || [],
      fromCache: true,
    };
  }

  if (fiiResult) {
    ({ fiiNet, fiiB, fiiS, diiNet, diiB, diiS } = fiiResult);
    fiiHistory = fiiResult.history || [];
    console.log(`FII OK: net ${fiiNet}, DII net ${diiNet}`);
  } else {
    console.log('FII unavailable — NSE blocked');
  }

  // ── NIFTY 50 stocks (heatmap + A/D) ────────────────────────────
  let nifty50Stocks=[], adv=0, dec=0, unc=0, topGainers=[], topLosers=[];
  try {
    const stockData = await nseAPI('/api/equity-stockIndices?index=NIFTY%2050');
    const stocks = (stockData?.data || []).filter(s => s.symbol !== 'NIFTY 50');
    nifty50Stocks = stocks.map(s => ({
      symbol: s.symbol, price: s.lastPrice, chgPct: s.pChange,
      chg: s.change, high: s.dayHigh, low: s.dayLow,
      open: s.open, prev: s.previousClose, mcap: s.totalMarketCap || 0,
    }));
    stocks.forEach(s => { if (s.pChange > 0) adv++; else if (s.pChange < 0) dec++; else unc++; });
    topGainers = [...nifty50Stocks].sort((a,b) => b.chgPct - a.chgPct).slice(0, 5);
    topLosers  = [...nifty50Stocks].sort((a,b) => a.chgPct - b.chgPct).slice(0, 5);
    console.log(`NSE stocks: ${nifty50Stocks.length} stocks, adv ${adv} dec ${dec}`);
  } catch(e) { console.log('NSE stocks failed:', e.message); }

  // ── MMI ─────────────────────────────────────────────────────────
  let mmi = 50;
  if (nifty50?.price && nifty50.fiftyTwoWeekLow && nifty50.fiftyTwoWeekHigh) {
    const range = nifty50.fiftyTwoWeekHigh - nifty50.fiftyTwoWeekLow;
    if (range > 0) mmi = (nifty50.price - nifty50.fiftyTwoWeekLow) / range * 100;
  }
  const vix = indiaVIX?.price || 0;
  if (vix > 0) { const vs=vix<12?85:vix<16?70:vix<20?50:vix<25?30:15; mmi=(mmi+vs)/2; }
  if (fiiNet != null) { const fs=fiiNet>2000?80:fiiNet>0?62:fiiNet>-2000?40:20; mmi=(mmi*2+fs)/3; }
  if (adv+dec > 0) { const as=(adv/(adv+dec))*100; mmi=(mmi*3+as)/4; }
  mmi = Math.max(0, Math.min(100, Math.round(mmi)));
  const mmiLabel = mmi>=70?'Extreme Greed':mmi>=55?'Greed':mmi>=45?'Neutral':mmi>=30?'Fear':'Extreme Fear';
  const mmiColor = mmi>=70?'#00c853':mmi>=55?'#76d275':mmi>=45?'#ffba00':mmi>=30?'#ff6f00':'#f44336';

  const data = {
    ts: Date.now(),
    nifty50, bankNifty, midcap, smallcap, sensex,
    niftyIT, niftyPharma, niftyFMCG, niftyAuto, niftyMetal, niftyRealty, niftyEnergy,
    indiaVIX, giftNifty: null,
    sp500: sp500 ? {...sp500, displayCurrency:'USD'} : null,
    nasdaq: nasdaq ? {...nasdaq, displayCurrency:'USD'} : null,
    dow: dow ? {...dow, displayCurrency:'USD'} : null,
    ftse: ftse ? {...ftse, displayCurrency:'GBP'} : null,
    hangseng: hangseng ? {...hangseng, displayCurrency:'HKD'} : null,
    nikkei: nikkei ? {...nikkei, displayCurrency:'JPY'} : null,
    dax: dax ? {...dax, displayCurrency:'EUR'} : null,
    crude, gold, silver, naturalGas,
    usdinr, eurinr, jpyinr, gbpinr, aedinr, usdInrRate,
    goldInr: goldRate || null,
    fiiNet, fiiB, fiiS, diiNet, diiB, diiS, fiiHistory,
    fiiFromCache: fiiResult?.fromCache || false,
    adv, dec, unc, nifty50Stocks, topGainers, topLosers,
    mmi, mmiLabel, mmiColor,
    niftyCloses: niftyHist?.closes || [],
  };

  mktCache = { data, fetchedAt: Date.now() };
  console.log(`=== Done: NIFTY ${nifty50?.price} VIX ${vix} FII ${fiiNet} Gold ₹${goldRate} ===`);
  res.json(data);
});

// ── Health ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'Surans Price Server v4.0',
    uptime: Math.round(process.uptime()) + 's',
    endpoints: ['/gold', '/nse/:symbol', '/us/:symbol', '/batch', '/marketdata?force=1'],
    cache: {
      market: mktCache.data ? Math.round((Date.now()-mktCache.fetchedAt)/1000)+'s ago' : 'empty',
      gold: goldCache.ibja ? `₹${goldCache.ibja}/g (${goldCache.source})` : 'empty',
      nseSession: nseSession.cookie ? 'active ('+Math.round((Date.now()-nseSession.fetchedAt)/60000)+'m ago)' : 'none',
    },
  });
});

app.listen(PORT, () => console.log('Surans Price Server v4.0 on port', PORT));
