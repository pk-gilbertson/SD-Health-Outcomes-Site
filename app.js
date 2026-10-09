'use strict';
/* South Dakota Health Outcomes: same pattern as South Dakota Pathways.
   Plain JavaScript, no libraries, no build step. Reads the JSON written by
   `python -m pipeline.cli site` into data/. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const fmt = (n) => (n == null ? '–' : nf.format(n));
const BASE_YEAR = 2015;                                  // "change since" reference year
const EVENTS = [{ year: 2020, label: 'COVID-19 pandemic' }];
const MAX_COMPARE = 3;                                   // three hues validate as distinct in both themes
const SLOTS = ['--s1', '--s2', '--s3'];
const DOMAINS = {
  mortality: 'Mortality and vital statistics', maternal_infant: 'Maternal, infant, and child health',
  behavior: 'Behavioral risk surveys', injury_violence: 'Injury and violence', substance_use: 'Substance use',
  infectious: 'Infectious disease', environmental: 'Environmental health', chronic: 'Chronic disease',
  health_system: 'Health system and workforce', disparities: 'American Indian health',
  program_eval: 'Program evaluations', agency: 'Agency-wide reports', unclassified: 'Other',
};
const CHECK_TITLES = {
  row_total_mismatch: 'A row doesn’t add up to its printed total',
  cross_series_infant_gap: 'Two reports imply an impossible number of infant deaths',
  excl_infant_exceeds_all_ages: 'A count excluding infants is larger than the all-ages count',
  component_exceeds_total: 'A cause of death is larger than the table total',
  partial_row_alignment: 'A row has fewer values than its table has columns',
  final_value_changed_between_editions: 'A final figure changed between editions',
  material_revision: 'A provisional figure was revised by more than 2%',
};

let meta, catalog = [], themes = [], reports = [], methods = {};
let measures = [], filtered = [], chosen = null, view = 'explore';
let sortKey = 'latest', sortDir = 'desc';
let compare = [];                     // [{id, slot}]; slot is kept while a measure stays selected
let detailCache = new Map(), detailSeries = null;

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const getJSON = (p) => fetch('data/' + p).then((r) => { if (!r.ok) throw new Error(`data/${p} returned ${r.status}`); return r.json(); });

/* ---------- derived values ---------- */
function pointsOf(m) { return (m.headline?.spark || []).map(([year, value, prov, withheld]) => ({ year, value, prov, withheld })); }
function valueAt(m, yr) { return pointsOf(m).find((p) => p.year === yr && p.value != null)?.value ?? null; }
function longChange(m) {
  const pts = pointsOf(m).filter((p) => p.value != null);
  if (!pts.length) return null;
  const base = pts.find((p) => p.year === BASE_YEAR) || pts[0];
  const last = pts[pts.length - 1];
  if (!base.value) return { pct: null, from: base.year, to: last.year, fromZero: true };
  return { pct: (last.value - base.value) / base.value * 100, from: base.year, to: last.year };
}
function changeHTML(pct, opts = {}) {
  if (pct == null) return opts.fromZero ? '<span class="muted">from zero</span>' : '–';
  const r = Math.round(pct * 10) / 10;
  if (r === 0) return 'No change';
  const cls = r > 0 ? 'up' : 'down';
  return `<span class="${cls}"><span class="arrow" aria-hidden="true">${r > 0 ? '▲' : '▼'}</span> ${r > 0 ? '+' : '−'}${fmt(Math.abs(r))}%</span>`;
}

/* ---------- views ---------- */
function setView(v) {
  view = v;
  document.querySelectorAll('.view').forEach((e) => (e.hidden = e.id !== v));
  document.querySelectorAll('nav button').forEach((e) => (e.dataset.view === v ? e.setAttribute('aria-current', 'page') : e.removeAttribute('aria-current')));
  const filtersOn = ['explore', 'compare'].includes(v);
  $('filters').hidden = !filtersOn; $('status').hidden = !filtersOn;
  if (v === 'compare') renderCompare();
  if (v === 'explore' && chosen) renderDetail();
}
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); setView(g.dataset.goto); } });

/* ---------- filters + table ---------- */
function apply() {
  const q = $('search').value.toLowerCase().trim(), topic = $('topic').value, pend = $('showPending').checked;
  filtered = measures.filter((m) => (pend || m.headline?.latest) && (!topic || m.theme === topic) &&
    (!q || (m.short_label + ' ' + m.label).toLowerCase().includes(q)));
  const key = (m) => sortKey === 'label' ? m.short_label : sortKey === 'latest' ? m.headline?.latest?.value
    : sortKey === 'oneyr' ? m.headline?.change?.pct : longChange(m)?.pct;
  filtered.sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka == null) return kb == null ? a.short_label.localeCompare(b.short_label) : 1;
    if (kb == null) return -1;
    const n = sortKey === 'label' ? ka.localeCompare(kb) : ka - kb;
    return (sortDir === 'asc' ? n : -n) || a.short_label.localeCompare(b.short_label);
  });
  if (!filtered.some((m) => m.id === chosen && m.headline?.latest)) chosen = filtered.find((m) => m.headline?.latest)?.id || null;
  render();
}
['search', 'topic', 'showPending'].forEach((id) => $(id).addEventListener('input', apply));
$('reset').onclick = () => { $('search').value = ''; $('topic').value = ''; $('showPending').checked = false; apply(); };
document.querySelectorAll('[data-sort]').forEach((b) => (b.onclick = () => {
  sortDir = sortKey === b.dataset.sort ? (sortDir === 'desc' ? 'asc' : 'desc') : (b.dataset.sort === 'label' ? 'asc' : 'desc');
  sortKey = b.dataset.sort; apply();
}));

function render() {
  ['label', 'latest', 'oneyr', 'long'].forEach((k) => {
    $('heading-' + k).setAttribute('aria-sort', sortKey === k ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    $('caret-' + k).textContent = sortKey === k && sortDir === 'asc' ? '▴' : '▾';
  });
  const active = filtered.filter((m) => m.headline?.latest);
  $('status').textContent = `${active.length} measure${active.length === 1 ? '' : 's'} match your filters · Statewide data`;
  $('rows').innerHTML = filtered.map((m) => {
    const h = m.headline;
    if (!h?.latest) {
      return `<tr class="pending"><td>${esc(m.short_label)}<br><span class="badge pend">${m.status === 'pending' ? 'Table not mapped yet' : 'No values yet'}</span></td><td>–</td><td>–</td><td>–</td></tr>`;
    }
    const lc = longChange(m);
    const held = pointsOf(m).some((p) => p.withheld);
    return `<tr class="${chosen === m.id ? 'selected' : ''}">
      <td><button class="pick" data-id="${m.id}" aria-pressed="${chosen === m.id}">${esc(m.short_label)}</button><br>
        <span class="muted">${esc(h.label)}</span>${h.latest.provisional ? ' <span class="badge prov">Provisional</span>' : ''}${held ? ' <span class="badge withheld">Value withheld</span>' : ''}</td>
      <td><strong>${fmt(h.latest.value)}</strong><br><span class="muted">${esc(h.latest.period)}</span></td>
      <td>${changeHTML(h.change?.pct)}${h.change ? `<br><span class="muted">vs ${esc(h.change.from_period)}</span>` : ''}</td>
      <td>${changeHTML(lc?.pct, lc || {})}${lc ? `<br><span class="muted">${lc.from}–${lc.to}</span>` : ''}</td></tr>`;
  }).join('') || `<tr><td colspan="4">No measures match. <button class="subtle" type="button" onclick="document.getElementById('reset').click()">Reset filters</button></td></tr>`;
  $('rows').querySelectorAll('button.pick').forEach((b) => (b.onclick = () => selectMeasure(b.dataset.id)));
  renderDetail();
  if (view === 'compare') renderCompare();
}

function selectMeasure(id) {
  chosen = id; detailSeries = null; render(); setView('explore');
  if (innerWidth < 1100) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- detail panel ---------- */
async function renderDetail() {
  const box = $('detail');
  const m = measures.find((x) => x.id === chosen);
  if (!m) { box.innerHTML = '<h2>Choose a measure</h2><p>Select any measure in the table to see its trend and where each number comes from.</p>'; return; }
  let ind = detailCache.get(m.id);
  if (!ind) {
    box.innerHTML = `<h2>${esc(m.short_label)}</h2><p class="note">Loading…</p>`;
    ind = await getJSON(`indicators/${m.id}.json`);
    detailCache.set(m.id, ind);
    if (chosen !== m.id) return;
  }
  const series = ind.series;
  const s = series.find((x) => x.key === detailSeries) || series.find((x) => x.key === m.headline.series_key) || series[0];
  detailSeries = s.key;
  const vals = s.points.filter((p) => p.value != null);
  const last = vals[vals.length - 1], first = vals[0];
  const peak = vals.reduce((a, b) => (b.value > a.value ? b : a), vals[0]);
  const prev = vals.length > 1 && vals[vals.length - 2].year === last.year - 1 ? vals[vals.length - 2] : null;
  const pct = prev && prev.value ? (last.value - prev.value) / prev.value * 100 : null;
  const held = s.points.filter((p) => p.withheld);
  const sources = [...new Map(s.points.map((p) => [p.source.url + p.source.page, p.source])).values()];
  const inCompare = compare.some((c) => c.id === m.id);

  box.innerHTML = `
    <p class="eyebrow">${esc(themes.find((t) => t.id === m.theme)?.title?.toUpperCase() || 'MEASURE')}</p>
    <h2>${esc(ind.label)}</h2>
    ${series.length > 1 ? `<div class="segsel" role="group" aria-label="Which count">${series.map((x) =>
      `<button type="button" data-series="${x.key}" aria-pressed="${x.key === s.key}">${esc(x.label)}</button>`).join('')}</div>`
      : `<p class="scope">${esc(s.label)}</p>`}
    ${ind.note ? `<p class="callout">${esc(ind.note)}</p>` : ''}
    <p class="big">${fmt(last.value)}</p>
    <p class="bigsub">${esc(ind.unit)} in ${esc(last.period)}${last.provisional ? ' (provisional)' : ''}. ${pct == null ? '' : changeHTML(pct) + ' from ' + esc(prev.period) + '.'}</p>
    ${held.length ? `<p class="note"><span class="badge withheld">Withheld</span> ${esc(held.map((p) => p.period).join(', '))} failed a data check. <a href="#" data-goto="checks">See why</a>.</p>` : ''}
    <div id="detailchart" class="chartbox" role="img" aria-label="${esc(summaryText(ind, s))}"></div>
    <p class="note">${esc(summaryText(ind, s))} Hollow points are provisional.</p>
    <dl>
      <dt>${esc(first.period)}</dt><dd>${fmt(first.value)}</dd>
      <dt>Highest</dt><dd>${fmt(peak.value)}<small>${esc(peak.period)}</small></dd>
    </dl>
    <div class="actions">
      <button type="button" id="addcompare" ${!inCompare && compare.length >= MAX_COMPARE ? 'disabled' : ''}>${inCompare ? 'View in comparison' : 'Compare this trend'}</button>
    </div>
    <hr>
    <h3>Where these numbers come from</h3>
    <div class="srcs">${sources.map((src) => `<a href="${esc(src.url)}${src.page ? '#page=' + src.page : ''}" target="_blank" rel="noopener">${esc(src.report)}${src.page ? `, page ${src.page}` : ''}</a>`).join('')}</div>
    ${ind.revisions.length ? `<p class="note">${ind.revisions.length} earlier provisional value${ind.revisions.length === 1 ? ' was' : 's were'} revised in later releases.</p>` : ''}
    <details><summary>Show values</summary><div class="tablewrap">${valuesTable(s)}</div></details>`;

  box.querySelectorAll('[data-series]').forEach((b) => (b.onclick = () => { detailSeries = b.dataset.series; renderDetail(); }));
  $('addcompare').onclick = () => { if (!inCompare) addCompare(m.id); setView('compare'); };
  lineChart($('detailchart'), [{ name: ind.short_label, color: css('--s1'), points: s.points.map((p) => ({ year: p.year, value: p.value, prov: p.provisional, withheld: p.withheld, src: p.source })) }],
    { height: 240, unit: ind.unit, showHeld: true });
}

function valuesTable(s) {
  return `<table><thead><tr><th scope="col">Period</th><th scope="col">Value</th><th scope="col">Source</th></tr></thead><tbody>${
    [...s.points].reverse().map((p) => `<tr><td>${esc(p.period)}</td><td>${p.withheld ? '<span class="badge withheld">Withheld</span>' : p.suppressed ? 'Suppressed' : fmt(p.value)}${p.provisional ? ' <span class="badge prov">Prov.</span>' : ''}</td>
      <td><a href="${esc(p.source.url)}${p.source.page ? '#page=' + p.source.page : ''}" target="_blank" rel="noopener">p. ${esc(p.source.page)}</a></td></tr>`).join('')}</tbody></table>`;
}

function summaryText(ind, s) {
  const v = s.points.filter((p) => p.value != null);
  if (!v.length) return 'No values to chart.';
  const a = v[0], b = v[v.length - 1], pk = v.reduce((x, y) => (y.value > x.value ? y : x));
  return `${ind.short_label}: ${fmt(a.value)} in ${a.period} and ${fmt(b.value)} in ${b.period}, highest ${fmt(pk.value)} in ${pk.period}.`;
}

/* ---------- line chart (SVG, one axis, crosshair tooltip, keyboard) ---------- */
function lineChart(box, series, { height = 300, indexed = false, unit = '', showHeld = false } = {}) {
  const W = Math.max(300, box.clientWidth || 600), H = height;
  const m = { t: 22, r: series.length > 1 ? 150 : 16, b: 28, l: 52 };
  const years = [...new Set(series.flatMap((s) => s.points.map((p) => p.year)))].sort((a, b) => a - b);
  if (!years.length) { box.innerHTML = '<p class="note">No values to chart.</p>'; return; }
  const vals = series.flatMap((s) => s.points.filter((p) => p.value != null).map((p) => p.value));
  let lo = indexed ? Math.min(100, ...vals) : 0, hi = Math.max(indexed ? 100 : 0, ...vals);
  const span = hi - lo || 1; hi += span * 0.08; if (indexed) lo -= span * 0.08;
  const ticks = niceTicks(lo, hi, 5); lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
  const x0 = years[0], x1 = years[years.length - 1];
  const step = (W - m.l - m.r) / Math.max(1, x1 - x0);
  const X = (yr) => m.l + (yr - x0) * step;
  const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const every = W < 480 ? 3 : W < 700 ? 2 : 1;
  let g = '';
  for (const e of EVENTS) if (e.year >= x0 && e.year <= x1) {
    const w = Math.max(10, step * 0.9);
    g += `<rect class="band" x="${X(e.year) - w / 2}" y="${m.t}" width="${w}" height="${H - m.t - m.b}"/>`;
    g += `<text class="bandlbl" x="${X(e.year)}" y="${m.t - 6}" text-anchor="middle">${esc(e.label)}</text>`;
  }
  for (const t of ticks) g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="axislbl" x="${m.l - 8}" y="${Y(t) + 4}" text-anchor="end">${fmt(t)}</text>`;
  g += `<line class="base" x1="${m.l}" x2="${W - m.r}" y1="${Y(indexed ? 100 : 0)}" y2="${Y(indexed ? 100 : 0)}"/>`;
  years.forEach((yr, i) => { if ((i % every === 0 && x1 - yr >= every) || yr === x1) g += `<text class="axislbl" x="${X(yr)}" y="${H - 8}" text-anchor="middle">${yr}</text>`; });
  const ends = [];
  for (const s of series) {
    let d = '', open = false;
    for (const p of s.points) { if (p.value == null) { open = false; continue; } d += `${open ? 'L' : 'M'}${X(p.year).toFixed(1)},${Y(p.value).toFixed(1)}`; open = true; }
    g += `<path class="ln" pathLength="1" d="${d}" style="stroke:${s.color}"/>`;
    for (const p of s.points) {
      if (p.value == null) continue;
      g += p.prov ? `<circle class="dotprov" cx="${X(p.year)}" cy="${Y(p.value)}" r="4" style="stroke:${s.color}"/>`
        : `<circle class="dot" cx="${X(p.year)}" cy="${Y(p.value)}" r="4" style="fill:${s.color}"/>`;
    }
    if (showHeld) for (const p of s.points.filter((p) => p.withheld)) {
      g += `<line class="held" x1="${X(p.year)}" x2="${X(p.year)}" y1="${H - m.b}" y2="${H - m.b - 26}"/><text class="heldlbl" x="${X(p.year)}" y="${H - m.b - 31}" text-anchor="middle">Withheld</text>`;
    }
    const lastP = [...s.points].reverse().find((p) => p.value != null);
    if (series.length > 1 && lastP) ends.push({ y: Y(lastP.value), x: X(lastP.year), name: s.name });
  }
  ends.sort((a, b) => a.y - b.y);                       // nudge direct labels apart
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
  for (const e of ends) g += `<text class="endlbl" x="${e.x + 10}" y="${e.y + 4}">${esc(e.name.length > 22 ? e.name.slice(0, 21) + '…' : e.name)}</text>`;
  g += `<line class="cross" id="cross" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>`;
  g += `<rect class="hit" x="${m.l - step / 2}" y="0" width="${W - m.l - m.r + step}" height="${H}"/>`;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" tabindex="0" aria-label="Chart. Use left and right arrow keys to read each year.">${g}</svg>`;

  const svg = box.querySelector('svg'), cross = svg.querySelector('#cross'), tip = $('tip');
  let idx = years.length - 1;
  const show = (i, cx, cy) => {
    idx = Math.max(0, Math.min(years.length - 1, i));
    const yr = years[idx];
    cross.setAttribute('x1', X(yr)); cross.setAttribute('x2', X(yr)); cross.setAttribute('visibility', 'visible');
    const rows = series.map((s) => {
      const p = s.points.find((q) => q.year === yr);
      const v = !p ? 'No value' : p.withheld ? 'Withheld' : p.value == null ? 'No value' : (indexed ? fmt(Math.round(p.value)) : fmt(p.value) + ' ' + unit) + (p.prov ? ' (provisional)' : '');
      return `<div>${series.length > 1 ? `<span class="sw" style="background:${s.color}"></span>${esc(s.name)}: ` : ''}${v}${!indexed && p?.src && series.length === 1 ? `<br><span class="muted">${esc(p.src.report)}, p. ${esc(p.src.page)}</span>` : ''}</div>`;
    }).join('');
    tip.innerHTML = `<strong>${yr}</strong>${rows}`;
    tip.hidden = false;
    const r = svg.getBoundingClientRect();
    const px = cx ?? r.left + X(yr) / W * r.width, py = cy ?? r.top + 20;
    tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, px + 14) + 'px';
    tip.style.top = Math.max(8, py - tip.offsetHeight - 10) + 'px';
  };
  const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect(), sx = (e.clientX - r.left) / r.width * W;
    const yr = x0 + Math.round((sx - m.l) / step);
    let best = 0; years.forEach((y, i) => { if (Math.abs(y - yr) < Math.abs(years[best] - yr)) best = i; });
    show(best, e.clientX, e.clientY);
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(idx + (e.key === 'ArrowRight' ? 1 : -1)); }
    if (e.key === 'Escape') hide();
  });
  svg.addEventListener('focus', () => show(idx));
}
function niceTicks(lo, hi, n) {
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw || 1)), stepv = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw);
  const out = []; for (let v = Math.floor(lo / stepv) * stepv; v <= hi + 1e-9; v += stepv) out.push(Math.round(v * 100) / 100);
  return out;
}

/* ---------- compare view ---------- */
function addCompare(id) {
  if (compare.some((c) => c.id === id) || compare.length >= MAX_COMPARE) return;
  const used = new Set(compare.map((c) => c.slot));
  compare.push({ id, slot: [0, 1, 2].find((s) => !used.has(s)) });   // color follows the measure, not its position
}
document.querySelectorAll('input[name=cmode]').forEach((r) => (r.onchange = renderCompare));

function renderCompare() {
  const mode = document.querySelector('input[name=cmode]:checked').value;
  const avail = filtered.filter((m) => m.headline?.latest);
  $('picker').innerHTML = avail.map((m) => {
    const c = compare.find((x) => x.id === m.id);
    return `<label><input type="checkbox" value="${m.id}" ${c ? 'checked' : ''} ${!c && compare.length >= MAX_COMPARE ? 'disabled' : ''}>
      <span class="sw" style="background:${c ? css(SLOTS[c.slot]) : 'transparent'}"></span>
      <span>${esc(m.short_label)}<br><small>${esc(m.headline.label)}</small></span></label>`;
  }).join('') || '<p class="note">No measures match your filters.</p>';
  $('picker').querySelectorAll('input').forEach((i) => (i.onchange = () => {
    if (i.checked) addCompare(i.value); else compare = compare.filter((c) => c.id !== i.value);
    renderCompare();
  }));

  const chosenM = compare.map((c) => ({ ...c, m: measures.find((x) => x.id === c.id) })).filter((c) => c.m);
  // indexed base: BASE_YEAR when every chosen measure has it, else the first year they all share
  const common = chosenM.length ? [...new Set(chosenM.flatMap((c) => pointsOf(c.m).map((p) => p.year)))].sort()
    .filter((yr) => chosenM.every((c) => valueAt(c.m, yr))) : [];
  const base = common.includes(BASE_YEAR) ? BASE_YEAR : common[0];
  const series = chosenM.map((c) => ({
    name: c.m.short_label, color: css(SLOTS[c.slot]),
    points: pointsOf(c.m).map((p) => ({ year: p.year, prov: p.prov, withheld: p.withheld,
      value: p.value == null ? null : mode === 'index' ? p.value / valueAt(c.m, base) * 100 : p.value })),
  }));
  document.querySelectorAll('#compare .seg .baseyr').forEach((e) => (e.textContent = base ?? BASE_YEAR));
  $('legend').innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
  if (!series.length) {
    $('comparechart').innerHTML = '<p class="note">Choose up to three measures on the right to compare their trends.</p>';
    $('comparenote').textContent = ''; $('comparetable').innerHTML = '';
  } else if (mode === 'index' && base == null) {
    $('comparechart').innerHTML = '<p class="note">These measures have no year in common, so they can’t be indexed. Switch to counts.</p>';
  } else {
    lineChart($('comparechart'), series, { height: 340, indexed: mode === 'index' });
    $('comparenote').textContent = mode === 'index'
      ? `Each line shows the count as a share of its ${base} value. 120 means 20% more deaths than in ${base}. Hollow points are provisional.`
      : 'Counts on one scale. Large causes flatten small ones; switch to indexed to compare change. Hollow points are provisional.';
    const yrs = [...new Set(series.flatMap((s) => s.points.map((p) => p.year)))].sort();
    $('comparetable').innerHTML = `<table><thead><tr><th scope="col">Year</th>${series.map((s) => `<th scope="col">${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${
      yrs.map((y) => `<tr><td>${y}</td>${series.map((s) => { const p = s.points.find((q) => q.year === y); return `<td>${p?.withheld ? 'Withheld' : fmt(p?.value == null ? null : Math.round(p.value * 10) / 10)}</td>`; }).join('')}</tr>`).join('')}</tbody></table>`;
  }
  renderChangeBars(avail);
}

function renderChangeBars(avail) {
  const rows = avail.map((m) => ({ m, c: longChange(m) })).filter((r) => r.c);
  const withPct = rows.filter((r) => r.c.pct != null).sort((a, b) => b.c.pct - a.c.pct);
  const max = Math.max(1, ...withPct.map((r) => Math.abs(r.c.pct)));
  $('changechart').innerHTML = withPct.map(({ m, c }) => {
    const w = Math.abs(c.pct) / max * 50;
    return `<div class="barrow" title="${esc(m.short_label)}: ${c.from} to ${c.to}">
      <button type="button" data-id="${m.id}">${esc(m.short_label)}<br><span class="muted">${esc(m.headline.label)}, ${c.from}–${c.to}</span></button>
      <div class="bartrack" aria-hidden="true"><span class="mid"></span><span class="fill ${c.pct >= 0 ? 'upbar' : 'downbar'}" style="${c.pct >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`}"></span></div>
      <span class="val">${changeHTML(c.pct)}</span></div>`;
  }).join('') + rows.filter((r) => r.c.pct == null).map(({ m, c }) =>
    `<p class="note">${esc(m.short_label)} had no deaths in ${c.from}, so a percent change can’t be shown.</p>`).join('');
  $('changechart').querySelectorAll('button[data-id]').forEach((b) => (b.onclick = () => selectMeasure(b.dataset.id)));
}

/* ---------- data checks ---------- */
function renderChecks() {
  const v = methods.validation || [];
  const sevOrder = { error: 0, warn: 1, info: 2 };
  const cards = [...v].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]).map((c) => {
    const rep = reports.find((r) => r.title === c.source_report);
    const what = c.severity === 'error' ? 'Withheld on this site until DOH confirms the original.'
      : c.severity === 'warn' ? 'Shown, flagged for a reviewer.' : 'Logged for the record.';
    return `<article class="check-card ${c.severity}">
      <p class="kind">${c.severity === 'error' ? 'Failed check' : c.severity === 'warn' ? 'Needs a look' : 'Note'}</p>
      <h3>${esc(CHECK_TITLES[c.check] || c.check)}</h3>
      <p><strong>Report:</strong> ${rep ? `<a href="${esc(rep.url)}${c.page ? '#page=' + esc(c.page) : ''}" target="_blank" rel="noopener">${esc(c.source_report)}</a>` : esc(c.source_report)}${c.page ? `, page ${esc(c.page)}` : ''}. <strong>Row:</strong> ${esc(c.row)}${c.period ? `. <strong>Period:</strong> ${esc(c.period.split(',')[0])}` : ''}.</p>
      <p>${esc(c.message)}</p>
      <p class="note">${what}</p></article>`;
  }).join('');
  $('checklist').innerHTML = (cards || '<article class="check-card ok-card"><h3>No open findings</h3><p>Every table the pipeline read passed its checks.</p></article>') +
    `<article class="panel"><h3>Checks run on every table</h3><ul>
      <li>Each row’s yearly values add up to its printed total.</li>
      <li>No single cause is larger than the table’s total deaths.</li>
      <li>All-ages deaths minus deaths excluding infants gives a believable number of infant deaths.</li>
      <li>A count excluding infants is never larger than the all-ages count.</li>
      <li>Final figures don’t change between editions of the same report.</li>
      <li>Provisional figures that move by more than 2% between releases are logged.</li></ul></article>`;
  const revs = methods.revisions_material || [];
  $('revisions').innerHTML = revs.length ? `<table><thead><tr><th scope="col">Measure</th><th scope="col">Year</th><th scope="col">Earlier</th><th scope="col">Now</th><th scope="col">Change</th></tr></thead><tbody>${
    revs.map((r) => `<tr><td>${esc(measures.find((x) => x.id === r.indicator_id)?.short_label || r.indicator_id)}</td><td>${esc(r.period)}</td><td>${fmt(+r.value)}</td><td>${fmt(+r.current_value)}</td><td>${changeHTML(+r.revision_pct)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="note">No revisions larger than 2% so far.</p>';
}

/* ---------- reports ---------- */
function renderReports() {
  const q = $('rsearch').value.toLowerCase().trim(), dom = $('rdomain').value, used = $('rused').checked;
  const hits = reports.filter((r) => (!dom || r.domain === dom) && (!q || r.title.toLowerCase().includes(q)) && (!used || r.used_by.length));
  const groups = new Map();
  hits.forEach((r) => { if (!groups.has(r.series_id)) groups.set(r.series_id, []); groups.get(r.series_id).push(r); });
  const name = (r) => r.title.replace(/,?\s*(\(?provisional\)?|\d{4}(\s*-\s*\d{4})?|SFY\s?\d{4}|(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}).*$/i, '').trim() || r.title;
  const list = [...groups.values()].sort((a, b) => name(a[0]).localeCompare(name(b[0])));
  $('rcount').textContent = `${hits.length} report${hits.length === 1 ? '' : 's'} in ${list.length} series`;
  $('reportlist').innerHTML = list.map((g) => {
    g.sort((a, b) => String(b.edition).localeCompare(String(a.edition)));
    const n = name(g[0]);
    const lab = (r) => {
      const dup = !r.edition || g.filter((x) => x.edition === r.edition).length > 1;
      if (!dup) return r.edition;
      let rest = r.title.replace(n, '').replace(/^[\s,:–-]+/, '').replace(/,?\s*\d{4}(\s*-\s*\d{4})?\s*$/, '').trim() || 'Full report';
      return (r.edition ? r.edition + ', ' : '') + (rest.length > 34 ? rest.slice(0, 32) + '…' : rest);
    };
    return `<div class="series"><div><h3>${esc(n)}</h3><span class="dom">${esc(DOMAINS[g[0].domain] || g[0].domain)}</span>${g.some((r) => r.used_by.length) ? ' <span class="badge prov" style="color:var(--accent-ink)">Used on this site</span>' : ''}</div>
      <ul class="editions">${g.map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener" title="${esc(r.title)}">${esc(lab(r))}</a>${r.provisional ? ' <span class="badge prov">Provisional</span>' : ''}</li>`).join('')}</ul></div>`;
  }).join('') || '<p>No reports match. Try a different search.</p>';
}
['rsearch', 'rdomain', 'rused'].forEach((id) => $(id).addEventListener('input', renderReports));

/* ---------- start ---------- */
async function init() {
  try {
    [meta, catalog, themes, reports, methods] = await Promise.all(['meta.json', 'catalog.json', 'themes.json', 'reports.json', 'methods.json'].map(getJSON));
  } catch (e) {
    $('status').innerHTML = `<strong>The data didn’t load.</strong> ${esc(e.message)}. Open this page through a web server, for example <code>python -m http.server 8000</code>.`;
    return;
  }
  measures = catalog;
  if (meta.mode === 'preview') $('banner').hidden = false;
  const [y0, y1] = meta.year_range || ['', ''];
  $('edition').innerHTML = `STATEWIDE SNAPSHOT<br><strong>${y0}–${y1}</strong><br>${meta.counts.reports} DOH reports`;
  $('builtinfo').textContent = `Built ${meta.built_at.slice(0, 10)} from ${meta.counts.reports} reports.`;
  document.querySelectorAll('.baseyr').forEach((e) => (e.textContent = BASE_YEAR));
  $('topic').innerHTML += themes.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
  $('rdomain').innerHTML += Object.entries(DOMAINS).filter(([k]) => reports.some((r) => r.domain === k)).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  const active = measures.filter((m) => m.headline?.latest).length;
  const errors = (methods.validation || []).filter((v) => v.severity === 'error').length;
  $('metrics').innerHTML = `
    <div class="metric"><span>Measures with data</span><strong>${active}</strong><small>of ${measures.length} defined; ${measures.length - active} waiting on table mapping</small></div>
    <div class="metric"><span>Values traced to a report page</span><strong>${fmt(meta.counts.rows)}</strong><small>From ${reports.filter((r) => r.used_by.length).length} of ${meta.counts.reports} DOH reports so far</small></div>
    <div class="metric"><span>Values withheld</span><strong>${meta.counts.withheld}</strong><small>${errors} open data check${errors === 1 ? '' : 's'}. <a href="#" data-goto="checks">See the checks</a></small></div>`;
  $('rules').innerHTML = (methods.rules || []).map((r) => `<dt>${esc(r.problem)}</dt><dd>${esc(r.rule)}</dd>`).join('');
  $('download').onclick = () => { location.href = 'data/downloads/indicators.csv'; };
  // a starting comparison: the deaths-of-despair measures that have data
  (themes.find((t) => t.id === 'deaths_of_despair')?.active || []).concat(['deaths_falls']).forEach(addCompare);
  renderChecks(); renderReports(); apply();
  let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { if (view === 'compare') renderCompare(); else renderDetail(); }, 150); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { renderDetail(); if (view === 'compare') renderCompare(); });
}
init();
