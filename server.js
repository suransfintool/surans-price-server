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
  res.json({ status: 'Surans Fin Tool Price Server running!' });
});

app.listen(PORT, () => {
  console.log(`Price server running on port ${PORT}`);
});
