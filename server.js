const express = require('express');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});


app.get('/api/quote/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();

    // Fetch quote metadata and 1D chart in parallel
    const [quote, summary, chartResult] = await Promise.all([
      yahooFinance.quote(ticker),
      yahooFinance.quoteSummary(ticker, { modules: ['summaryDetail', 'price'] }),
      yahooFinance.chart(ticker, { period1: getStartOf1D(), interval: '5m' }),
    ]);

    // Use the last candle close from the 1D chart so the header price always
    // matches the chart — regularMarketPrice can lag behind intraday data.
    const candles = (chartResult.quotes || []).filter(q => q.close != null);
    const price = candles.length > 0
      ? candles[candles.length - 1].close
      : quote.regularMarketPrice;

    const prevClose = quote.regularMarketPreviousClose;
    const change = price - prevClose;
    const changePct = (change / prevClose) * 100;

    res.json({
      ticker,
      price,
      change: change.toFixed(2),
      changePct: changePct.toFixed(2),
      high52w: summary.summaryDetail?.fiftyTwoWeekHigh ?? quote.fiftyTwoWeekHigh,
      low52w: summary.summaryDetail?.fiftyTwoWeekLow ?? quote.fiftyTwoWeekLow,
      name: quote.longName || quote.shortName || ticker,
      currency: quote.currency || 'USD',
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch quote' });
  }
});

app.get('/api/chart/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const { range } = req.query;

    const rangeMap = {
      '1D': { period1: getStartOf1D(), interval: '5m' },
      '1W': { period1: daysAgo(7),    interval: '30m' },
      '1M': { period1: daysAgo(30),   interval: '1d' },
      '3M': { period1: daysAgo(90),   interval: '1d' },
      'YTD': { period1: startOfYear(), interval: '1d' },
    };

    const config = rangeMap[range] || rangeMap['1D'];

    const result = await yahooFinance.chart(ticker, {
      period1: config.period1,
      interval: config.interval,
    });

    const quotes = result.quotes || [];
    const labels = quotes.map(q => {
      const d = new Date(q.date);
      if (range === '1D') {
        return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London' });
      }
      return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: 'Europe/London' });
    });

    const prices = quotes.map(q => q.close != null ? parseFloat(q.close.toFixed(2)) : null);

    res.json({ labels, prices });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch chart data' });
  }
});

app.get('/api/options/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const { expiry } = req.query; // optional ISO date string e.g. 2026-05-30

    const opts = expiry
      ? await yahooFinance.options(ticker, { date: new Date(expiry) })
      : await yahooFinance.options(ticker);

    // All available expiry dates (epoch ms → ISO string for the client)
    const expirationDates = (opts.expirationDates || []).map(d =>
      new Date(d).toISOString().slice(0, 10)
    );

    const chain = opts.options[0] || {};

    // Strip contract symbols and heavy fields; keep what we need
    const mapContract = c => ({
      strike:           c.strike,
      last:             c.lastPrice,
      bid:              c.bid,
      ask:              c.ask,
      volume:           c.volume ?? 0,
      openInterest:     c.openInterest ?? 0,
      iv:               c.impliedVolatility != null
                          ? parseFloat((c.impliedVolatility * 100).toFixed(1))
                          : null,
      inTheMoney:       c.inTheMoney,
      expiration:       new Date(c.expiration).toISOString().slice(0, 10),
    });

    res.json({
      ticker,
      underlyingPrice: opts.quote?.regularMarketPrice ?? null,
      expirationDates,
      selectedExpiry:  expirationDates[0] ?? null,
      calls:           (chain.calls  || []).map(mapContract),
      puts:            (chain.puts   || []).map(mapContract),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch options' });
  }
});

app.get('/price', async (req, res) => {
  console.log('[/price] query:', req.query);
  console.log('[/price] user-agent:', req.headers['user-agent']);
  console.log('[/price] host:', req.headers['host']);
  try {
    const ticker = (req.query.ticker || '').trim().toUpperCase();
    if (!ticker) return res.status(400).json({ error: 'Missing ticker parameter' });

    const [quote, chartResult] = await Promise.all([
      yahooFinance.quote(ticker),
      yahooFinance.chart(ticker, { period1: getStartOf1D(), interval: '5m' }),
    ]);

    const candles = (chartResult.quotes || []).filter(q => q.close != null);
    const price = candles.length > 0
      ? candles[candles.length - 1].close
      : quote.regularMarketPrice;

    const prevClose = quote.regularMarketPreviousClose;
    const change = parseFloat((price - prevClose).toFixed(4));
    const changePercent = parseFloat(((change / prevClose) * 100).toFixed(4));

    // Derive session state from Yahoo's marketState field
    const marketState = (quote.marketState || '').toUpperCase();
    const session = {
      PRE:         'premarket',
      PREPRE:      'premarket',
      REGULAR:     'open',
      POST:        'afterhours',
      POSTPOST:    'afterhours',
      CLOSED:      'closed',
    }[marketState] ?? 'closed';

    const lastCandle = candles[candles.length - 1];
    const timestamp = lastCandle
      ? new Date(lastCandle.date).toISOString()
      : new Date().toISOString();

    res.json({
      ticker,
      price,
      change,
      changePercent,
      session,
      previousClose: prevClose,
      timestamp,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch price' });
  }
});

app.post('/api/strike-check', async (req, res) => {
  try {
    const { ticker, strike } = req.body;
    if (!ticker || strike == null) return res.status(400).json({ error: 'Missing ticker or strike' });

    const tickerUp = ticker.toUpperCase();
    const strikeNum = parseFloat(strike);
    if (isNaN(strikeNum)) return res.status(400).json({ error: 'Invalid strike price' });

    const [quote, summary, chartResult] = await Promise.all([
      yahooFinance.quote(tickerUp),
      yahooFinance.quoteSummary(tickerUp, { modules: ['summaryDetail'] }),
      yahooFinance.chart(tickerUp, { period1: getStartOf1D(), interval: '5m' }),
    ]);

    const candles = (chartResult.quotes || []).filter(q => q.close != null);
    const currentPrice = candles.length > 0
      ? candles[candles.length - 1].close
      : quote.regularMarketPrice;
    const high52w = summary.summaryDetail?.fiftyTwoWeekHigh ?? quote.fiftyTwoWeekHigh;
    const low52w  = summary.summaryDetail?.fiftyTwoWeekLow  ?? quote.fiftyTwoWeekLow;

    const moveNeeded = ((strikeNum - currentPrice) / currentPrice) * 100;
    const absMoveNeeded = Math.abs(moveNeeded);
    const direction = strikeNum > currentPrice ? 'UP' : 'DOWN';

    // Check if strike has ever traded — is it within 52-week range?
    const everTraded = strikeNum >= low52w && strikeNum <= high52w;

    // Resistance: within 2% of 52-week high
    const nearHigh52w = strikeNum >= high52w * 0.98;

    // Near support: within 2% of 52-week low
    const nearLow52w = strikeNum <= low52w * 1.02;

    let verdict, reason, verdictClass;

    if (!everTraded) {
      verdict = 'REJECTED';
      verdictClass = 'rejected';
      if (strikeNum > high52w) {
        reason = `Strike $${strikeNum} is above the 52-week high of $${high52w.toFixed(2)}. The stock has never traded this high in the past year — this would require unprecedented price action.`;
      } else {
        reason = `Strike $${strikeNum} is below the 52-week low of $${low52w.toFixed(2)}. The stock has never traded this low in the past year.`;
      }
    } else if (absMoveNeeded > 20) {
      verdict = 'REJECTED';
      verdictClass = 'rejected';
      reason = `Needs a ${absMoveNeeded.toFixed(1)}% move ${direction}. That's an extreme move — low probability for a short-dated options trade.`;
    } else if (nearHigh52w && direction === 'UP') {
      verdict = 'CAUTION';
      verdictClass = 'caution';
      reason = `Strike is near the 52-week high of $${high52w.toFixed(2)}, which is a strong resistance level. The stock needs to move ${absMoveNeeded.toFixed(1)}% higher and break through a ceiling it hasn't cleared in a year.`;
    } else if (nearLow52w && direction === 'DOWN') {
      verdict = 'CAUTION';
      verdictClass = 'caution';
      reason = `Strike is near the 52-week low of $${low52w.toFixed(2)}, which is a strong support level. The stock would need to break through a floor it hasn't breached in a year.`;
    } else if (absMoveNeeded > 10) {
      verdict = 'CAUTION';
      verdictClass = 'caution';
      reason = `Needs a ${absMoveNeeded.toFixed(1)}% move ${direction}. Achievable but requires significant momentum — size accordingly.`;
    } else {
      verdict = 'PASS';
      verdictClass = 'pass';
      reason = `Strike is within a realistic ${absMoveNeeded.toFixed(1)}% move ${direction} and falls within the stock's 52-week trading range ($${low52w.toFixed(2)}–$${high52w.toFixed(2)}). No obvious structural barriers.`;
    }

    res.json({
      currentPrice,
      strike: strikeNum,
      moveNeeded: moveNeeded.toFixed(2),
      direction,
      high52w,
      low52w,
      everTraded,
      nearHigh52w,
      nearLow52w,
      verdict,
      verdictClass,
      reason,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Strike check failed' });
  }
});

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function startOfYear() {
  const d = new Date();
  return new Date(d.getFullYear(), 0, 1);
}

function getStartOf1D() {
  const d = new Date();
  // Go back 1 day but capture today's session — use yesterday as period1
  d.setDate(d.getDate() - 1);
  return d;
}

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`TradeScanner running at http://localhost:${PORT}`);

  // Keep Render free tier awake — ping self every 10 minutes
  if (process.env.RENDER) {
    const SELF = 'https://tradescanner-kn7u.onrender.com/price?ticker=AAPL';
    setInterval(() => {
      fetch(SELF).catch(() => {});
    }, 10 * 60 * 1000);
    console.log('Keep-warm ping active (every 10 min)');
  }
});
