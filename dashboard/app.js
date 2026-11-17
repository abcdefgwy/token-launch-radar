(() => {
  const data = window.__RADAR_DATA__;
  if (!data || !Array.isArray(data.rows)) {
    document.body.innerHTML = '<div style="padding:32px;font-family:monospace;color:#f43f5e;">Missing ../data.js payload (window.__RADAR_DATA__).</div>';
    return;
  }

  const { summary, rows } = data;
  const state = {
    search: '',
    category: 'ALL',
    chain: 'ALL',
    watchlistOnly: false,
    sortKey: 'rank',
    sortDir: 'asc',
    selectedSlug: null,
  };

  const els = {
    metaLine: document.getElementById('meta-line'),
    asOfPill: document.getElementById('as-of-pill'),
    floorPill: document.getElementById('floor-pill'),
    kpiPreToken: document.getElementById('kpi-pre-token'),
    kpiPreSub: document.getElementById('kpi-pre-sub'),
    kpiWatchlist: document.getElementById('kpi-watchlist'),
    kpiImpliedFdv: document.getElementById('kpi-implied-fdv'),
    kpiTvlSub: document.getElementById('kpi-tvl-sub'),
    kpiMomentum: document.getElementById('kpi-momentum'),
    searchInput: document.getElementById('search-input'),
    categorySelect: document.getElementById('category-select'),
    chainSelect: document.getElementById('chain-select'),
    watchlistToggle: document.getElementById('watchlist-toggle'),
    visibleCount: document.getElementById('visible-count'),
    resetBtn: document.getElementById('reset-btn'),
    tbody: document.getElementById('radar-tbody'),
    headers: Array.from(document.querySelectorAll('thead th.sortable')),
    drawer: document.getElementById('detail-drawer'),
    drawerBadges: document.getElementById('drawer-badges'),
    drawerTitle: document.getElementById('drawer-title'),
    drawerSlug: document.getElementById('drawer-slug'),
    drawerBody: document.getElementById('drawer-body'),
    drawerClose: document.getElementById('drawer-close'),
  };

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtUsd(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '--';
    const abs = Math.abs(n);
    if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${Math.round(n)}`;
  }

  function fmtPct(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return 'N/A';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)}%`;
  }

  function fmtChains(chains) {
    if (!chains || chains.length === 0) return '--';
    if (chains.length <= 2) return chains.join(', ');
    return `${chains[0]}, ${chains[1]} +${chains.length - 2}`;
  }

  function parseBadges(step) {
    const costMatch = step.match(/est\.\s*(\$[0-9.,]+(?:\s*gas(?:\/fee)?)?)/i);
    const capMatch = step.match(/(\$[0-9.,]+[kK]?\+?\s*cap)/i);
    const timeMatch = step.match(/((?:one-time|weekly|bi-weekly|monthly)\s*~?[0-9]+m(?:\s*\w+)?)/i);
    return {
      cost: costMatch ? costMatch[1] : (capMatch ? capMatch[1] : 'Variable'),
      time: timeMatch ? timeMatch[1] : 'Periodic',
    };
  }

  function initHeaderAndKpis() {
    els.asOfPill.textContent = `AS OF ${summary.as_of}`;
    els.floorPill.textContent = `FLOOR ${fmtUsd(summary.floor_usd)}`;
    els.metaLine.textContent = `PRE-TOKEN DEFI VALUATION & FARMING TERMINAL // ${summary.ranked_count} RANKED`;

    const totalTvl = rows.reduce((acc, r) => acc + r.tvl_usd, 0);
    els.kpiPreToken.textContent = String(summary.pre_token_count);
    els.kpiPreSub.textContent = `${summary.ranked_count} ranked (${summary.live_token_count} live excluded)`;
    els.kpiWatchlist.textContent = `${summary.watchlist_covered}/${summary.watchlist_total}`;
    els.kpiImpliedFdv.textContent = fmtUsd(summary.total_implied_fdv_usd);
    els.kpiTvlSub.textContent = `Cohort TVL ${fmtUsd(totalTvl)}`;

    const med = summary.median_change_7d;
    els.kpiMomentum.textContent = fmtPct(med);
    els.kpiMomentum.className = `kpi-value ${med >= 0 ? 'pos' : 'neg'}`;

    for (const cat of summary.categories) {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      els.categorySelect.appendChild(opt);
    }
    for (const ch of summary.chains) {
      const opt = document.createElement('option');
      opt.value = ch;
      opt.textContent = ch;
      els.chainSelect.appendChild(opt);
    }
  }

  function getFilteredAndSorted() {
    const q = state.search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (state.watchlistOnly && !r.is_watchlist) return false;
      if (state.category !== 'ALL' && r.category !== state.category) return false;
      if (state.chain !== 'ALL' && !r.chains.includes(state.chain)) return false;
      if (q && !r.name.toLowerCase().includes(q) && !r.slug.toLowerCase().includes(q)) return false;
      return true;
    });

    const dir = state.sortDir === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      const k = state.sortKey;
      let va = a[k];
      let vb = b[k];
      if (k === 'chains') {
        va = a.chains.length;
        vb = b.chains.length;
      }
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'string' && typeof vb === 'string') {
        return va.localeCompare(vb) * dir;
      }
      return (va - vb) * dir;
    });
    return filtered;
  }

  function renderTable() {
    const list = getFilteredAndSorted();
    els.visibleCount.textContent = String(list.length);

    if (list.length === 0) {
      els.tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:28px;color:#8494ad;">No protocols match current filters.</td></tr>';
      return;
    }

    const html = list.map((r) => {
      const chCls = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      const selCls = r.slug === state.selectedSlug ? 'selected' : '';
      return `
        <tr data-slug="${esc(r.slug)}" class="${selCls}">
          <td class="num">#${r.rank}</td>
          <td>
            <div class="proto-cell">
              <span class="proto-name">${esc(r.name)}</span>
              ${r.is_watchlist ? '<span class="wl-tag">WL</span>' : ''}
            </div>
          </td>
          <td><span class="cat-tag">${esc(r.category)}</span></td>
          <td class="chain-list" title="${esc(r.chains.join(', '))}">${esc(fmtChains(r.chains))}</td>
          <td class="num">${fmtUsd(r.tvl_usd)}</td>
          <td class="num ${chCls}">${fmtPct(r.change_7d)}</td>
          <td class="num">${r.age_days}d</td>
          <td class="num" style="font-weight:700;color:#e6edf7;">${fmtUsd(r.implied_value_usd)}</td>
          <td class="num"><span class="conf-pill conf-${r.confidence}">${r.confidence} (${r.confidence_score})</span></td>
        </tr>
      `;
    }).join('');
    els.tbody.innerHTML = html;

    els.headers.forEach((th) => {
      const isAct = th.dataset.sort === state.sortKey;
      th.classList.toggle('active-sort', isAct);
      const ind = th.querySelector('.sort-ind');
      if (ind) ind.textContent = isAct ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
    });
  }

  function openDrawer(slug) {
    const row = rows.find((r) => r.slug === slug);
    if (!row) return;
    state.selectedSlug = slug;
    renderTable();

    els.drawerBadges.innerHTML = `
      <span class="pill pill-accent">RANK #${row.rank}</span>
      ${row.is_watchlist ? '<span class="wl-tag">WATCHLIST</span>' : ''}
      <span class="cat-tag">${esc(row.category)}</span>
      <span class="conf-pill conf-${row.confidence}">${row.confidence} (${row.confidence_score})</span>
    `;
    els.drawerTitle.textContent = row.name;
    els.drawerSlug.textContent = `${row.slug} · Listed ${row.listed_at || 'N/A'} (${row.age_days}d) · Chains: ${row.chains.join(', ')}`;

    const b = row.breakdown;
    const weights = [
      { cls: 'seg-tvl', val: 1.0, label: 'Base TVL' },
      { cls: 'seg-cat', val: Math.max(0.2, b.category_multiple - 0.5), label: 'Category' },
      { cls: 'seg-mom', val: b.momentum_factor * 0.45, label: 'Momentum' },
      { cls: 'seg-sea', val: b.seasoning_factor * 0.4, label: 'Seasoning' },
      { cls: 'seg-chn', val: (b.multichain_bonus - 0.8) * 1.2, label: 'Multi-Chain' },
    ];
    const totalW = weights.reduce((s, w) => s + w.val, 0);
    const barHtml = weights
      .map((w) => `<div class="${w.cls}" style="width:${((w.val / totalW) * 100).toFixed(1)}%" title="${w.label}"></div>`)
      .join('');

    const stepsHtml = row.farm_steps
      .map((step, i) => {
        const badges = parseBadges(step);
        return `
          <div class="step-card">
            <div class="step-top">
              <span class="step-num">STEP 0${i + 1}</span>
              <div class="step-badges">
                <span class="badge-cost">${esc(badges.cost)}</span>
                <span class="badge-time">${esc(badges.time)}</span>
              </div>
            </div>
            <p class="step-text">${esc(step)}</p>
          </div>
        `;
      })
      .join('');

    els.drawerBody.innerHTML = `
      <div class="stat-row">
        <div class="stat-box">
          <div class="k">CURRENT TVL</div>
          <div class="v">${fmtUsd(row.tvl_usd)}</div>
        </div>
        <div class="stat-box">
          <div class="k">IMPLIED FDV</div>
          <div class="v accent-green">${fmtUsd(row.implied_value_usd)}</div>
        </div>
        <div class="stat-box">
          <div class="k">7D MOMENTUM</div>
          <div class="v ${row.change_7d !== null && row.change_7d >= 0 ? 'pos' : 'neg'}">${fmtPct(row.change_7d)}</div>
        </div>
      </div>

      <div class="breakdown-card">
        <h3 class="section-title">Implied FDV Valuation Breakdown</h3>
        <div class="val-bar">${barHtml}</div>
        <div class="factor-grid">
          <div class="factor-item"><span>TVL Base</span><strong>${fmtUsd(b.tvl_usd)}</strong></div>
          <div class="factor-item"><span>Category Multiple</span><strong>${b.category_multiple.toFixed(2)}x</strong></div>
          <div class="factor-item"><span>7d Momentum</span><strong>${b.momentum_factor.toFixed(2)}x</strong></div>
          <div class="factor-item"><span>Seasoning</span><strong>${b.seasoning_factor.toFixed(2)}x</strong></div>
          <div class="factor-item"><span>Multi-Chain Bonus</span><strong>${b.multichain_bonus.toFixed(2)}x</strong></div>
          <div class="factor-item"><span>Implied FDV</span><strong class="accent-green">${fmtUsd(row.implied_value_usd)}</strong></div>
        </div>
      </div>

      <div>
        <h3 class="section-title">Institutional Farm Plan (${row.primary_chain})</h3>
        <div class="step-list">${stepsHtml}</div>
      </div>
    `;

    els.drawer.classList.add('open');
    els.drawer.setAttribute('aria-hidden', 'false');
  }

  function closeDrawer() {
    state.selectedSlug = null;
    els.drawer.classList.remove('open');
    els.drawer.setAttribute('aria-hidden', 'true');
    renderTable();
  }

  function applyQueryParams() {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    const cat = params.get('category');
    const chain = params.get('chain');
    const wl = params.get('watchlist');
    const slug = params.get('slug');

    if (cat && summary.categories.includes(cat)) {
      state.category = cat;
      els.categorySelect.value = cat;
    }
    if (chain && summary.chains.includes(chain)) {
      state.chain = chain;
      els.chainSelect.value = chain;
    }
    if (wl === '1' || wl === 'true') {
      state.watchlistOnly = true;
      els.watchlistToggle.checked = true;
    }

    renderTable();

    if (view === 'detail') {
      const target = slug || (rows.find((r) => r.is_watchlist) || rows[0])?.slug;
      if (target) openDrawer(target);
    } else if (slug) {
      openDrawer(slug);
    }
  }

  els.searchInput.addEventListener('input', (e) => {
    state.search = e.target.value;
    renderTable();
  });
  els.categorySelect.addEventListener('change', (e) => {
    state.category = e.target.value;
    renderTable();
  });
  els.chainSelect.addEventListener('change', (e) => {
    state.chain = e.target.value;
    renderTable();
  });
  els.watchlistToggle.addEventListener('change', (e) => {
    state.watchlistOnly = e.target.checked;
    renderTable();
  });
  els.resetBtn.addEventListener('click', () => {
    state.search = '';
    state.category = 'ALL';
    state.chain = 'ALL';
    state.watchlistOnly = false;
    state.sortKey = 'rank';
    state.sortDir = 'asc';
    els.searchInput.value = '';
    els.categorySelect.value = 'ALL';
    els.chainSelect.value = 'ALL';
    els.watchlistToggle.checked = false;
    closeDrawer();
  });

  els.headers.forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = key === 'rank' || key === 'name' || key === 'category' ? 'asc' : 'desc';
      }
      renderTable();
    });
  });

  els.tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-slug]');
    if (tr) openDrawer(tr.dataset.slug);
  });
  els.drawerClose.addEventListener('click', closeDrawer);

  initHeaderAndKpis();
  applyQueryParams();
})();
