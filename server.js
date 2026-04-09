const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from your Cloudflare app
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ── 🥇 GOLD PRICE (IBJA — India's official bullion rate) ─────────
// Server-side fetch bypasses CORS — same source as Aura Gold/Augmont/SafeGold
let goldCache = { ibja: 0, fetchedAt: 0 };

app.get('/gold', async (req, res) => {
  // Cache 10 minutes
  if (goldCache.ibja > 0 && Date.now() - goldCache.fetchedAt < 10 * 60 * 1000) {
    return res.json({
      ibja: goldCache.ibja,
      aura: +(goldCache.ibja * 1.022).toFixed(2),
      per10g: +(goldCache.ibja * 10).toFixed(2),
      source: goldCache.source + ' (cached)',
      fetchedAt: new Date(goldCache.fetchedAt).toISOString()
    });
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Referer': 'https://www.google.com/'
  };

  // Source 1: ibjarates.com — official IBJA daily rate (per gram shown on page)
  try {
    const r = await axios.get('https://ibjarates.com/', { headers, timeout: 10000 });
    const html = r.data;
    // IBJA page shows "14890 (1 Gram)" pattern for 999 purity
    const m = html.match(/999 Purity[\s\S]{0,200}?(\d{4,6})\s*\(1 Gram\)/i)
           || html.match(/<h3[^>]*>\s*(\d{4,6})\s*<\/h3>/);
    if (m) {
      const rate = parseFloat(m[1]);
      if (rate > 8000 && rate < 30000) {
        goldCache = { ibja: rate, source: 'ibjarates.com', fetchedAt: Date.now() };
        return res.json({ ibja: rate, aura: +(rate * 1.022).toFixed(2), per10g: rate * 10, source: 'ibjarates.com' });
      }
    }
    // Also parse from table — IBJA shows 10g rates in table: "148990" → 14899/g
    const m2 = html.match(/>\s*(1[34567]\d{4})\s*<\/td>/);
    if (m2) {
      const rate10g = parseFloat(m2[1]);
      if (rate10g > 100000 && rate10g < 300000) {
        const rate = +(rate10g / 10).toFixed(2);
        goldCache = { ibja: rate, source: 'ibjarates.com (10g)', fetchedAt: Date.now() };
        return res.json({ ibja: rate, aura: +(rate * 1.022).toFixed(2), per10g: rate10g, source: 'ibjarates.com (10g)' });
      }
    }
  } catch(e) { console.warn('Gold src1 ibjarates failed:', e.message); }

  // Source 2: Goodreturns — scrapes IBJA, India-specific, very reliable
  try {
    const r = await axios.get('https://www.goodreturns.in/gold-rates/', { headers, timeout: 10000 });
    const html = r.data;
    // "₹14,984 per gram for 24 karat gold"
    const m = html.match(/[\u20B9₹]([\d,]+)\s*per\s*gram\s*for\s*24/i)
           || html.match(/24\s*(?:karat|carat|k)[^₹\u20B9]*[\u20B9₹]([\d,]+)\s*per\s*gram/i);
    if (m) {
      const rate = parseFloat(m[1].replace(/,/g, ''));
      if (rate > 8000 && rate < 30000) {
        goldCache = { ibja: rate, source: 'goodreturns.in', fetchedAt: Date.now() };
        return res.json({ ibja: rate, aura: +(rate * 1.022).toFixed(2), per10g: rate * 10, source: 'goodreturns.in' });
      }
    }
  } catch(e) { console.warn('Gold src2 goodreturns failed:', e.message); }

  // Source 3: MCX Gold via NSE/Yahoo Finance (GC=F international × duties)
  try {
    const r = await axios.get(
      'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=1d',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }
    );
    const meta = r.data?.chart?.result?.[0]?.meta;
    const usdPerOz = meta?.regularMarketPrice || meta?.previousClose;
    if (usdPerOz > 0) {
      // Get USD/INR rate
      let usdInr = 84;
      try {
        const fx = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 5000 });
        usdInr = fx.data?.rates?.INR || 84;
      } catch(e) {}
      // India gold = international + 6% import duty + 3% GST + ~5% bank/dealer margin = 14%
      const rate = +((usdPerOz / 31.1035) * usdInr * 1.14).toFixed(2);
      if (rate > 8000 && rate < 30000) {
        goldCache = { ibja: rate, source: 'MCX-equivalent (Yahoo+duty)', fetchedAt: Date.now() };
        return res.json({ ibja: rate, aura: +(rate * 1.022).toFixed(2), per10g: rate * 10, source: 'MCX-equivalent' });
      }
    }
  } catch(e) { console.warn('Gold src3 yahoo failed:', e.message); }

  // Source 4: goldpricez free API (no key needed for basic access)
  try {
    const r = await axios.get('https://data-asg.goldprice.org/dbXRates/INR',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    const inrPerOz = r.data?.items?.[0]?.xauPrice;
    if (inrPerOz > 100000) {
      const rate = +((inrPerOz / 31.1035)).toFixed(2);
      if (rate > 8000 && rate < 30000) {
        goldCache = { ibja: rate, source: 'goldprice.org', fetchedAt: Date.now() };
        return res.json({ ibja: rate, aura: +(rate * 1.022).toFixed(2), per10g: rate * 10, source: 'goldprice.org' });
      }
    }
  } catch(e) { console.warn('Gold src4 failed:', e.message); }

  res.status(503).json({ error: 'Could not fetch gold price', ibja: null });
});

// ── Indian stocks (NSE) ──────────────────────────────────────────
app.get('/nse/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    // Try NSE India direct API
    const r = await axios.get(
      `https://www.nseindia.com/api/quote-equity?symbol=${symbol}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.nseindia.com',
          'Cookie': ''
        },
        timeout: 8000
      }
    );
    const price = r.data?.priceInfo?.lastPrice
               || r.data?.priceInfo?.close
               || r.data?.lastPrice;
    if (price) return res.json({ symbol, price, source: 'NSE' });
  } catch(e) {}

  // Fallback: Yahoo Finance (server-side, no CORS issue)
  try {
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS?interval=1d&range=1d`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000
      }
    );
    const meta = r.data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice || meta?.previousClose;
    if (price) return res.json({ symbol, price, source: 'Yahoo' });
  } catch(e) {}

  // Fallback 2: Yahoo query2
  try {
    const r = await axios.get(
      `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}.NS?interval=1d&range=1d`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000
      }
    );
    const meta = r.data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice || meta?.previousClose;
    if (price) return res.json({ symbol, price, source: 'Yahoo2' });
  } catch(e) {}

  res.status(404).json({ symbol, price: null, error: 'Price not found' });
});

// ── US stocks ────────────────────────────────────────────────────
app.get('/us/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000
      }
    );
    const meta = r.data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice || meta?.previousClose;
    if (price) return res.json({ symbol, price, source: 'Yahoo' });
  } catch(e) {}

  res.status(404).json({ symbol, price: null, error: 'Price not found' });
});

// ── Batch endpoint (multiple symbols at once) ────────────────────
app.get('/batch', async (req, res) => {
  const { symbols, type } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });

  const list = symbols.split(',').map(s => s.trim().toUpperCase());
  const results = {};

  await Promise.all(list.map(async sym => {
    try {
      const ticker = type === 'IN' ? `${sym}.NS` : sym;
      const r = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }
      );
      const meta = r.data?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice || meta?.previousClose;
      if (price) results[sym] = price;
    } catch(e) {}
  }));

  res.json(results);
});

// ── Health check ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'Surans Fin Tool Price Server v2.0 running!',
    endpoints: ['/gold', '/nse/:symbol', '/us/:symbol', '/batch?symbols=X,Y&type=IN'],
    goldCache: goldCache.ibja > 0 ? `₹${goldCache.ibja}/g (${goldCache.source})` : 'not fetched yet'
  });
});

app.listen(PORT, () => {
  console.log(`Price server running on port ${PORT}`);
});

app.get('/nse/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    // Try NSE India direct API
    const r = await axios.get(
      `https://www.nseindia.com/api/quote-equity?symbol=${symbol}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.nseindia.com',
          'Cookie': ''
        },
        timeout: 8000
      }
    );
    const price = r.data?.priceInfo?.lastPrice
               || r.data?.priceInfo?.close
               || r.data?.lastPrice;
    if (price) return res.json({ symbol, price, source: 'NSE' });
  } catch(e) {}

  // Fallback: Yahoo Finance (server-side, no CORS issue)
  try {
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS?interval=1d&range=1d`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000
      }
    );
    const meta = r.data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice || meta?.previousClose;
    if (price) return res.json({ symbol, price, source: 'Yahoo' });
  } catch(e) {}

  // Fallback 2: Yahoo query2
  try {
    const r = await axios.get(
      `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}.NS?interval=1d&range=1d`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000
      }
    );
    const meta = r.data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice || meta?.previousClose;
    if (price) return res.json({ symbol, price, source: 'Yahoo2' });
  } catch(e) {}

  res.status(404).json({ symbol, price: null, error: 'Price not found' });
});

// ── US stocks ────────────────────────────────────────────────────
app.get('/us/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000
      }
    );
    const meta = r.data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice || meta?.previousClose;
    if (price) return res.json({ symbol, price, source: 'Yahoo' });
  } catch(e) {}

  res.status(404).json({ symbol, price: null, error: 'Price not found' });
});

// ── Batch endpoint (multiple symbols at once) ────────────────────
app.get('/batch', async (req, res) => {
  const { symbols, type } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });

  const list = symbols.split(',').map(s => s.trim().toUpperCase());
  const results = {};

  await Promise.all(list.map(async sym => {
    try {
      const ticker = type === 'IN' ? `${sym}.NS` : sym;
      const r = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }
      );
      const meta = r.data?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice || meta?.previousClose;
      if (price) results[sym] = price;
    } catch(e) {}
  }));

  res.json(results);
});

// ── Health check ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Surans Fin Tool Price Server running!' });
});

app.listen(PORT, () => {
  console.log(`Price server running on port ${PORT}`);
});
