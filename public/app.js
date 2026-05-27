(() => {
  let currentTicker = '';
  let currentRange = '1D';
  let chartInstance = null;
  let quoteData = null;

  const tickerInput  = document.getElementById('tickerInput');
  const searchBtn    = document.getElementById('searchBtn');
  const quoteCard    = document.getElementById('quoteCard');
  const chartSection = document.getElementById('chartSection');
  const strikeSection= document.getElementById('strikeSection');
  const strikeInput  = document.getElementById('strikeInput');
  const strikeBtn    = document.getElementById('strikeBtn');
  const strikeResult = document.getElementById('strikeResult');
  const globalError  = document.getElementById('globalError');

  // ── Search ──────────────────────────────────────────────────────────────────
  searchBtn.addEventListener('click', doSearch);
  tickerInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  async function doSearch() {
    const ticker = tickerInput.value.trim().toUpperCase();
    if (!ticker) return;
    currentTicker = ticker;
    strikeResult.classList.add('hidden');
    await loadQuote(ticker);
  }

  async function loadQuote(ticker) {
    setLoading(true);
    try {
      const data = await apiFetch(`/api/quote/${ticker}`);
      quoteData = data;
      renderQuote(data);
      quoteCard.classList.remove('hidden');
      chartSection.classList.remove('hidden');
      strikeSection.classList.remove('hidden');
      optionsSection.classList.remove('hidden');
      expirySelect.innerHTML = '';
      optionsCache = {};
      currentSide = 'calls';
      document.querySelectorAll('.chain-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.side === 'calls');
        b.classList.remove('puts');
      });
      setActiveRange('1D');
      await Promise.all([loadChart(ticker, '1D'), loadOptions(ticker, null)]);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function renderQuote(d) {
    document.getElementById('stockName').textContent = d.name;
    document.getElementById('stockTicker').textContent = d.ticker;
    document.getElementById('stockPrice').textContent = fmt(d.price, d.currency);
    const changeEl = document.getElementById('stockChange');
    const sign = d.changePct >= 0 ? '+' : '';
    changeEl.textContent = `${sign}${d.change} (${sign}${d.changePct}%)`;
    changeEl.className = 'change ' + (parseFloat(d.changePct) >= 0 ? 'up' : 'down');
    document.getElementById('high52w').textContent = fmt(d.high52w, d.currency);
    document.getElementById('low52w').textContent  = fmt(d.low52w, d.currency);
  }

  // ── Chart ────────────────────────────────────────────────────────────────────
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!currentTicker) return;
      setActiveRange(btn.dataset.range);
      loadChart(currentTicker, btn.dataset.range);
    });
  });

  function setActiveRange(range) {
    currentRange = range;
    document.querySelectorAll('.tf-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.range === range);
    });
  }

  async function loadChart(ticker, range) {
    const loader = document.getElementById('chartLoader');
    const errEl  = document.getElementById('chartError');
    loader.classList.remove('hidden');
    errEl.classList.add('hidden');

    try {
      const data = await apiFetch(`/api/chart/${ticker}?range=${range}`);
      renderChart(data, range);
    } catch (err) {
      errEl.textContent = 'Chart unavailable: ' + err.message;
      errEl.classList.remove('hidden');
    } finally {
      loader.classList.add('hidden');
    }
  }

  function renderChart({ labels, prices }, range) {
    const ctx = document.getElementById('priceChart').getContext('2d');

    // Compute tight Y-axis bounds from actual data
    const validPrices = prices.filter(p => p != null);
    const isUp = validPrices.length > 1
      ? validPrices[validPrices.length - 1] >= validPrices[0]
      : true;
    const lineColor = isUp ? '#00c805' : '#ff5000';

    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

    // Thin the labels for readability
    const step = Math.ceil(labels.length / 6);
    const displayLabels = labels.map((l, i) => (i % step === 0 ? l : ''));

    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: displayLabels,
        datasets: [{
          data: prices,
          borderColor: lineColor,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: lineColor,
          tension: 0.2,
          fill: true,
          backgroundColor: ctx => {
            const gradient = ctx.chart.ctx.createLinearGradient(0, 0, 0, 220);
            gradient.addColorStop(0, isUp ? 'rgba(0,200,5,0.18)' : 'rgba(255,80,0,0.18)');
            gradient.addColorStop(1, 'rgba(0,0,0,0)');
            return gradient;
          },
          spanGaps: true,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1e1e1e',
            borderColor: '#2a2a2a',
            borderWidth: 1,
            titleColor: '#888',
            bodyColor: '#f0f0f0',
            bodyFont: { weight: '700', size: 14 },
            callbacks: {
              title: items => labels[items[0].dataIndex] || '',
              label: item => item.raw != null ? `$${item.raw.toFixed(2)}` : 'N/A',
            }
          }
        },
        scales: {
          x: {
            grid: { color: '#1a1a1a' },
            ticks: { color: '#555', font: { size: 11 }, maxRotation: 0 },
          },
          y: {
            position: 'right',
            grid: { color: '#1a1a1a' },
            min: (() => {
              const lo = Math.min(...validPrices);
              const hi = Math.max(...validPrices);
              const pad = (hi - lo) * 0.1 || lo * 0.01;
              return lo - pad;
            })(),
            max: (() => {
              const lo = Math.min(...validPrices);
              const hi = Math.max(...validPrices);
              const pad = (hi - lo) * 0.1 || lo * 0.01;
              return hi + pad;
            })(),
            ticks: {
              color: '#555',
              font: { size: 11 },
              maxTicksLimit: 6,
              callback: v => `$${v.toFixed(2)}`,
            },
          }
        }
      }
    });
  }

  // ── Strike check ─────────────────────────────────────────────────────────────
  strikeBtn.addEventListener('click', doStrikeCheck);
  strikeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doStrikeCheck(); });

  async function doStrikeCheck() {
    const strike = parseFloat(strikeInput.value);
    if (!currentTicker || isNaN(strike)) return;
    strikeBtn.textContent = 'Checking…';
    strikeBtn.disabled = true;
    try {
      const d = await apiFetch('/api/strike-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: currentTicker, strike }),
      });
      renderStrikeResult(d);
      strikeResult.classList.remove('hidden');
    } catch (err) {
      showError(err.message);
    } finally {
      strikeBtn.textContent = 'Check';
      strikeBtn.disabled = false;
    }
  }

  function renderStrikeResult(d) {
    const icons = { pass: '✅', caution: '⚠️', rejected: '❌' };
    const labels = { pass: 'PASS', caution: 'CAUTION', rejected: 'REJECTED' };

    const moveSign = parseFloat(d.moveNeeded) >= 0 ? '+' : '';
    const moveClass = parseFloat(d.moveNeeded) >= 0 ? 'up' : 'down';

    const everTradedVal = d.everTraded
      ? '<span class="strike-row-value good">Yes — within 52W range</span>'
      : '<span class="strike-row-value warn">No — outside 52W range</span>';

    const nearHighVal = d.nearHigh52w
      ? '<span class="strike-row-value warn">Yes — near 52W high resistance</span>'
      : '<span class="strike-row-value good">No</span>';

    strikeResult.innerHTML = `
      <div class="strike-verdict ${d.verdictClass}">
        <span class="verdict-icon">${icons[d.verdictClass]}</span>
        <span>${labels[d.verdictClass]}</span>
      </div>
      <div class="strike-details">
        <div class="strike-row">
          <span class="strike-row-label">Current price</span>
          <span class="strike-row-value">$${d.currentPrice.toFixed(2)}</span>
        </div>
        <div class="strike-row">
          <span class="strike-row-label">Strike</span>
          <span class="strike-row-value">$${d.strike.toFixed(2)}</span>
        </div>
        <div class="strike-row">
          <span class="strike-row-label">Move needed</span>
          <span class="strike-row-value ${moveClass}">${moveSign}${d.moveNeeded}%</span>
        </div>
        <div class="strike-row">
          <span class="strike-row-label">52W range</span>
          <span class="strike-row-value">$${d.low52w.toFixed(2)} – $${d.high52w.toFixed(2)}</span>
        </div>
        <div class="strike-row">
          <span class="strike-row-label">Ever traded here?</span>
          ${everTradedVal}
        </div>
        <div class="strike-row">
          <span class="strike-row-label">Near 52W high?</span>
          ${nearHighVal}
        </div>
      </div>
      <div class="strike-reason">${d.reason}</div>
    `;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  async function apiFetch(url, opts = {}) {
    const res = await fetch(url, opts);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  function fmt(price, currency = 'USD') {
    if (price == null) return '—';
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(price);
  }

  function setLoading(on) {
    searchBtn.textContent = on ? 'Loading…' : 'Search';
    searchBtn.disabled = on;
  }

  function showError(msg) {
    globalError.textContent = msg;
    globalError.classList.remove('hidden');
    setTimeout(() => globalError.classList.add('hidden'), 4000);
  }

  // ── Options chain ─────────────────────────────────────────────────────────────
  const optionsSection = document.getElementById('optionsSection');
  const expirySelect   = document.getElementById('expirySelect');
  const optionsLoader  = document.getElementById('optionsLoader');
  const optionsError   = document.getElementById('optionsError');
  const optionsBody    = document.getElementById('optionsBody');
  let currentSide      = 'calls';
  let optionsCache     = {};  // keyed by expiry date

  async function loadOptions(ticker, expiry) {
    optionsLoader.classList.remove('hidden');
    optionsError.classList.add('hidden');
    optionsBody.innerHTML = '';
    try {
      const url = `/api/options/${ticker}` + (expiry ? `?expiry=${expiry}` : '');
      const data = await apiFetch(url);

      // Populate expiry dropdown on first load
      if (expirySelect.options.length === 0) {
        data.expirationDates.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d;
          opt.textContent = formatExpiry(d);
          expirySelect.appendChild(opt);
        });
      }

      optionsCache[data.selectedExpiry] = data;
      renderOptionsTable(data, currentSide);
    } catch (err) {
      optionsError.textContent = 'Options unavailable: ' + err.message;
      optionsError.classList.remove('hidden');
    } finally {
      optionsLoader.classList.add('hidden');
    }
  }

  function renderOptionsTable(data, side) {
    const contracts = data[side] || [];
    const underlying = data.underlyingPrice;
    optionsBody.innerHTML = '';

    contracts.forEach(c => {
      const distPct = underlying
        ? Math.abs((c.strike - underlying) / underlying * 100)
        : 99;
      const itm = c.inTheMoney;
      const atm = distPct < 1.5;

      const tr = document.createElement('tr');
      if (atm)       tr.classList.add('atm');
      else if (itm)  tr.classList.add(side === 'puts' ? 'itm-put' : 'itm');

      const ivClass = c.iv != null
        ? (c.iv > 80 ? 'iv-high' : c.iv < 30 ? 'iv-low' : '')
        : '';

      const copClass = c.cop != null
        ? (c.cop >= 60 ? 'iv-low' : c.cop <= 30 ? 'iv-high' : '')
        : '';

      tr.innerHTML = `
        <td>${c.strike.toFixed(2)}</td>
        <td><strong>${c.mark != null ? c.mark.toFixed(2) : '—'}</strong></td>
        <td>${c.last != null ? c.last.toFixed(2) : '—'}</td>
        <td>${c.bid  != null ? c.bid.toFixed(2)  : '—'}</td>
        <td>${c.ask  != null ? c.ask.toFixed(2)  : '—'}</td>
        <td>${c.volume > 0 ? c.volume.toLocaleString() : '—'}</td>
        <td>${c.openInterest > 0 ? c.openInterest.toLocaleString() : '—'}</td>
        <td class="${ivClass}">${c.iv != null ? c.iv + '%' : '—'}</td>
        <td class="${copClass}">${c.cop != null ? c.cop + '%' : '—'}</td>
      `;

      // Tap row → pre-fill strike sense check
      tr.addEventListener('click', () => {
        strikeInput.value = c.strike;
        document.getElementById('strikeSection').scrollIntoView({ behavior: 'smooth' });
        strikeInput.focus();
      });

      optionsBody.appendChild(tr);
    });

    if (contracts.length === 0) {
      optionsBody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-dim);padding:20px">No data</td></tr>';
    }
  }

  // Expiry dropdown change
  expirySelect.addEventListener('change', () => {
    const expiry = expirySelect.value;
    if (optionsCache[expiry]) {
      renderOptionsTable(optionsCache[expiry], currentSide);
    } else {
      loadOptions(currentTicker, expiry);
    }
  });

  // Calls / Puts tab switch
  document.querySelectorAll('.chain-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      currentSide = btn.dataset.side;
      document.querySelectorAll('.chain-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.side === currentSide);
        if (b.dataset.side === 'puts') b.classList.toggle('puts', b.classList.contains('active'));
      });
      const expiry = expirySelect.value || null;
      const cached = optionsCache[expiry];
      if (cached) renderOptionsTable(cached, currentSide);
    });
  });

  function formatExpiry(iso) {
    const d = new Date(iso + 'T12:00:00Z');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ── URL parameter pre-load ────────────────────────────────────────────────────
  (function initFromURL() {
    const params = new URLSearchParams(window.location.search);
    const ticker = params.get('ticker');
    const strike = params.get('strike');
    if (strike) strikeInput.value = strike;
    if (ticker) {
      tickerInput.value = ticker.toUpperCase();
      currentTicker = ticker.toUpperCase();
      loadQuote(ticker.toUpperCase()).then(() => {
        if (strike) doStrikeCheck();
      });
    }
  })();
})();
