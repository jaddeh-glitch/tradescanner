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

// ── Black-Scholes helpers ────────────────────────────────────────────────────
const R = 0.045; // approximate US risk-free rate

function normCDF(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741,
        a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const poly = ((((a5*t + a4)*t + a3)*t + a2)*t + a1)*t;
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-x * x)));
}

function normPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Returns { cop, delta, gamma, theta, vega, rho } or nulls if IV unusable
function calcGreeks(type, S, K, T, iv) {
  if (!S || !K || !T || !iv || iv < 0.005) {
    return { cop: null, delta: null, gamma: null, theta: null, vega: null, rho: null };
  }
  const sigma = iv;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (R + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const eRT = Math.exp(-R * T);
  const nd1 = normPDF(d1);

  const isCall = type === 'call';
  const cop   = parseFloat(((isCall ? normCDF(d2) : normCDF(-d2)) * 100).toFixed(2));
  const delta = parseFloat((isCall ? normCDF(d1) : normCDF(d1) - 1).toFixed(4));
  const gamma = parseFloat((nd1 / (S * sigma * sqrtT)).toFixed(4));
  // Theta: per calendar day
  const thetaYear = isCall
    ? (-S * nd1 * sigma / (2 * sqrtT)) - R * K * eRT * normCDF(d2)
    : (-S * nd1 * sigma / (2 * sqrtT)) + R * K * eRT * normCDF(-d2);
  const theta = parseFloat((thetaYear / 365).toFixed(4));
  // Vega: per 1% move in IV
  const vega  = parseFloat((S * nd1 * sqrtT / 100).toFixed(4));
  // Rho: per 1% move in risk-free rate
  const rho   = parseFloat((isCall
    ?  K * T * eRT * normCDF(d2)  / 100
    : -K * T * eRT * normCDF(-d2) / 100).toFixed(4));

  return { cop, delta, gamma, theta, vega, rho };
}

// Keep backward-compat shim for /api/options chain usage
function calcCOP(type, S, K, T, iv) {
  return calcGreeks(type, S, K, T, iv).cop;
}

app.get('/api/options/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const { expiry } = req.query;

    const opts = expiry
      ? await yahooFinance.options(ticker, { date: new Date(expiry) })
      : await yahooFinance.options(ticker);

    const expirationDates = (opts.expirationDates || []).map(d =>
      new Date(d).toISOString().slice(0, 10)
    );

    const chain = opts.options[0] || {};
    const underlyingPrice = opts.quote?.regularMarketPrice ?? null;
    const marketState = (opts.quote?.marketState || '').toUpperCase();
    const marketOpen = marketState === 'REGULAR';

    const mapContract = (c, type) => {
      const bid  = c.bid  > 0 ? c.bid  : null;
      const ask  = c.ask  > 0 ? c.ask  : null;
      const last = c.lastPrice > 0 ? c.lastPrice : null;

      // Mark: mid when bid/ask live, else last price
      const mark = (bid != null && ask != null)
        ? parseFloat(((bid + ask) / 2).toFixed(2))
        : last;

      const ivRaw = c.impliedVolatility ?? 0;          // decimal e.g. 0.35
      const ivPct = ivRaw > 0
        ? parseFloat((ivRaw * 100).toFixed(1))
        : null;

      // Time to expiry in years
      const msPerYear = 365.25 * 24 * 3600 * 1000;
      const T = (new Date(c.expiration) - Date.now()) / msPerYear;

      const cop = calcCOP(type, underlyingPrice, c.strike, T, ivRaw);

      return {
        strike:       c.strike,
        last,
        bid,
        ask,
        mark,
        volume:       c.volume ?? 0,
        openInterest: c.openInterest ?? 0,
        iv:           ivPct,
        cop,                     // % chance of expiring ITM (null = market closed / no IV)
        inTheMoney:   c.inTheMoney,
        expiration:   new Date(c.expiration).toISOString().slice(0, 10),
      };
    };

    res.json({
      ticker,
      underlyingPrice,
      marketOpen,
      expirationDates,
      selectedExpiry:  expirationDates[0] ?? null,
      calls:           (chain.calls || []).map(c => mapContract(c, 'call')),
      puts:            (chain.puts  || []).map(c => mapContract(c, 'put')),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch options' });
  }
});

app.get('/option', async (req, res) => {
  try {
    const { ticker, strike, type, expiry } = req.query;

    if (!ticker)  return res.status(400).json({ error: 'Missing ticker' });
    if (!strike)  return res.status(400).json({ error: 'Missing strike' });
    if (!type)    return res.status(400).json({ error: 'Missing type (call or put)' });
    if (!expiry)  return res.status(400).json({ error: 'Missing expiry (YYYY-MM-DD)' });

    const tickerUp   = ticker.toUpperCase();
    const strikeNum  = parseFloat(strike);
    const side       = type.toLowerCase() === 'put' ? 'puts' : 'calls';
    const expiryDate = new Date(expiry);

    if (isNaN(strikeNum))         return res.status(400).json({ error: 'Invalid strike' });
    if (isNaN(expiryDate.getTime())) return res.status(400).json({ error: 'Invalid expiry date' });

    const opts = await yahooFinance.options(tickerUp, { date: expiryDate });
    const chain = opts.options[0] || {};
    const contracts = chain[side] || [];

    // Find closest strike match
    const contract = contracts.reduce((best, c) =>
      Math.abs(c.strike - strikeNum) < Math.abs(best.strike - strikeNum) ? c : best
    , contracts[0]);

    if (!contract) return res.status(404).json({ error: 'No contracts found for that expiry' });

    const underlyingPrice = opts.quote?.regularMarketPrice ?? null;
    const marketState     = (opts.quote?.marketState || '').toUpperCase();
    const marketOpen      = marketState === 'REGULAR';
    const contractType    = side === 'calls' ? 'call' : 'put';

    // Fetch the contract symbol directly for accurate volume, prev close, high, low
    const cq = await yahooFinance.quote(contract.contractSymbol).catch(() => null);

    // Prefer contract quote bid/ask (more current), fall back to options chain
    const bid  = (cq?.bid  > 0 ? cq.bid  : contract.bid  > 0 ? contract.bid  : null);
    const ask  = (cq?.ask  > 0 ? cq.ask  : contract.ask  > 0 ? contract.ask  : null);
    const last = cq?.regularMarketPrice ?? (contract.lastPrice > 0 ? contract.lastPrice : null);
    const mark = (bid != null && ask != null)
      ? parseFloat(((bid + ask) / 2).toFixed(2))
      : last;

    const prevClose  = cq?.regularMarketPreviousClose ?? null;
    const dayHigh    = cq?.regularMarketDayHigh ?? null;
    const dayLow     = cq?.regularMarketDayLow  ?? null;
    const volume     = cq?.regularMarketVolume  ?? contract.volume ?? 0;
    const changeAmt  = (last != null && prevClose != null)
      ? parseFloat((last - prevClose).toFixed(2)) : null;
    const changePct  = (changeAmt != null && prevClose)
      ? parseFloat((changeAmt / prevClose * 100).toFixed(2)) : null;

    const ivRaw = contract.impliedVolatility ?? 0;
    const ivPct = ivRaw > 0 ? parseFloat((ivRaw * 100).toFixed(2)) : null;

    const msPerYear = 365.25 * 24 * 3600 * 1000;
    const T = (new Date(contract.expiration) - Date.now()) / msPerYear;
    const greeks = calcGreeks(contractType, underlyingPrice, contract.strike, T, ivRaw);

    const moveNeeded = underlyingPrice
      ? parseFloat(((contract.strike - underlyingPrice) / underlyingPrice * 100).toFixed(2))
      : null;

    res.json({
      ticker:           tickerUp,
      type:             contractType,
      strike:           contract.strike,
      expiry:           new Date(contract.expiration).toISOString().slice(0, 10),
      contractSymbol:   contract.contractSymbol,
      underlyingPrice,
      moveNeededPct:    moveNeeded,
      // Pricing
      mark,
      last,
      bid,
      ask,
      prevClose,
      dayHigh,
      dayLow,
      change:           changeAmt,
      changePct,
      // Activity
      volume,
      openInterest:     contract.openInterest ?? 0,
      volumeDelayedMins: 20,          // Yahoo options data is 20-min delayed
      // Volatility & probability
      iv:               ivPct,
      cop:              greeks.cop,
      // Greeks
      greeks: {
        delta: greeks.delta,
        gamma: greeks.gamma,
        theta: greeks.theta,
        vega:  greeks.vega,
        rho:   greeks.rho,
      },
      inTheMoney:       contract.inTheMoney,
      session:          marketOpen ? 'open' : marketState.toLowerCase() || 'closed',
      timestamp:        new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch option' });
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
