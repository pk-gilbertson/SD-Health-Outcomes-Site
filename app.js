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

let meta, catalog = [], themes = [], reports = [], methods = {}, rel = {};
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
    ${held.length ? heldNote(held) : ''}
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

const CHECK_PLAIN = {
  row_total_mismatch: 'The yearly values in this row don’t add up to the total printed beside them.',
  cross_series_infant_gap: 'Compared with the all-ages count, this value implies far more infant deaths than South Dakota has in a year.',
  excl_infant_exceeds_all_ages: 'This count is larger than the all-ages count for the same year, which can’t happen.',
  component_exceeds_total: 'This cause is larger than the table’s total deaths.',
};
function heldNote(held) {
  const reps = new Set(held.map((p) => p.source.report)), periods = held.map((p) => String(p.period));
  const why = (methods.validation || []).filter((v) => v.severity === 'error' && reps.has(v.source_report) &&
    String(v.period).split(',').some((x) => periods.includes(x)));
  const extra = why.find((v) => v.check === 'row_total_mismatch')?.message.match(/should be ([\d,]+)/);
  return `<div class="heldbox"><p><span class="badge withheld">Withheld</span> The ${esc(periods.join(', '))} value is left off this chart until the Department of Health confirms it.</p>
    <ul>${[...new Set(why.map((v) => CHECK_PLAIN[v.check] || v.message))].map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    ${extra ? `<p class="note">If the printed total is right, the value should be ${esc(extra[1])}.</p>` : ''}</div>`;
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
const nameOf = (id) => measures.find((x) => x.id === id)?.short_label || id;
function addCompare(id) {
  if (compare.some((c) => c.id === id) || compare.length >= MAX_COMPARE) return;
  const used = new Set(compare.map((c) => c.slot));
  compare.push({ id, slot: [0, 1, 2].find((s) => !used.has(s)) });   // color follows the measure, not its position
}
function setCompare(ids) { compare = []; ids.slice(0, MAX_COMPARE).forEach(addCompare); renderCompare(); }
function removeCompare(id) { compare = compare.filter((c) => c.id !== id); renderCompare(); }
document.querySelectorAll('input[name=cmode]').forEach((r) => (r.onchange = renderCompare));

function pairSentence(p, from) {
  return p.direction === 'together'
    ? `Rose and fell with ${esc(nameOf(from))} in ${p.same_direction_years} of ${p.years} years`
    : `Moved opposite to ${esc(nameOf(from))} in ${p.years - p.same_direction_years} of ${p.years} years`;
}
function pairTags(p) {
  return `<span class="tag ${p.direction}">${p.direction === 'together' ? 'Moves with' : 'Moves opposite'}</span>` +
    (p.holds_without_pandemic ? '<span class="tag plain">Holds without 2020–21</span>' : '<span class="tag plain">Mostly 2020–21</span>') +
    (p.p_value < 0.05 ? '' : '<span class="tag plain">Could be chance</span>');
}

/* Candidates not on the chart whose year-to-year changes lined up (|r| >= 0.5) with something on it. */
function suggestionsFor(selected) {
  const out = new Map();
  for (const p of rel.pairs || []) {
    if (Math.abs(p.r) < 0.5) continue;
    const inA = selected.includes(p.a), inB = selected.includes(p.b);
    if (inA === inB) continue;
    const cand = inA ? p.b : p.a, from = inA ? p.a : p.b;
    if (!filtered.some((m) => m.id === cand)) continue;               // follow the filters
    const prev = out.get(cand);
    if (!prev || Math.abs(p.r) > Math.abs(prev.p.r)) out.set(cand, { id: cand, from, p });
  }
  return [...out.values()].sort((x, y) => Math.abs(y.p.r) - Math.abs(x.p.r)).slice(0, 4);
}

function renderSuggestions() {
  const sel = compare.map((c) => c.id);
  const full = compare.length >= MAX_COMPARE;
  if (!sel.length) {
    $('suggestnote').textContent = 'Start with one of the strongest pairs, or add any measure and this list fills with others that moved with it.';
    $('suggestions').innerHTML = topPairsHTML(3, true);
  } else {
    const sug = suggestionsFor(sel);
    $('suggestnote').textContent = sug.length
      ? `Measures whose year-to-year changes lined up with ${sel.map(nameOf).join(', ')}.${full ? ' Remove one from the chart to add another.' : ''}`
      : `Nothing else moved consistently with ${sel.map(nameOf).join(', ')}. Try another measure, or browse all of them.`;
    $('suggestions').innerHTML = sug.map((s) => `<div class="sugg">
        <div><strong>${esc(nameOf(s.id))}</strong><p>${pairSentence(s.p, s.from)}.</p>
        <div class="tags">${pairTags(s.p)}</div>${s.p.note ? `<p class="note">${esc(s.p.note)}</p>` : ''}</div>
        <button type="button" data-add="${s.id}" ${full ? 'disabled' : ''} aria-label="Add ${esc(nameOf(s.id))} to the chart">Add</button></div>`).join('');
  }
  $('suggestions').querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => { addCompare(b.dataset.add); renderCompare(); }));
  $('suggestions').querySelectorAll('[data-pair]').forEach((b) => (b.onclick = () => setCompare(b.dataset.pair.split(','))));
}

function topPairsHTML(n, compact) {
  const list = (rel.pairs || []).filter((p) => Math.abs(p.r) >= 0.5 && filtered.some((m) => m.id === p.a) && filtered.some((m) => m.id === p.b)).slice(0, n);
  if (!list.length) return '<p class="note">No pairs among the filtered measures moved consistently together.</p>';
  const r = (v) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
  return list.map((p) => `<div class="sugg${compact ? '' : ' wide'}">
      <div><strong>${esc(nameOf(p.a))} and ${esc(nameOf(p.b))}</strong>
      <p>${p.direction === 'together' ? `Moved the same direction in ${p.same_direction_years} of ${p.years} years` : `Moved in opposite directions in ${p.years - p.same_direction_years} of ${p.years} years`}, ${p.first_year}–${p.last_year}.${compact ? '' : ` Correlation ${r(p.r)}${p.r_without_2020_21 != null ? `, ${r(p.r_without_2020_21)} without 2020–21` : ''}.`}</p>
      <div class="tags">${pairTags(p)}</div>${p.note && !compact ? `<p class="note">${esc(p.note)}</p>` : ''}</div>
      <button type="button" data-pair="${p.a},${p.b}">Chart this pair</button></div>`).join('');
}

function renderPairs() {
  const m = rel.method || {};
  const sig = (rel.pairs || []).filter((p) => p.p_value < 0.05).length;
  $('pairsnote').textContent = m.pairs_tested
    ? `${m.pairs_tested} pairs were tested. If none were truly related, about ${fmt(m.expected_p05_by_chance)} would look this strong by chance; ${sig} do. Read these as leads, not findings.`
    : '';
  $('pairs').innerHTML = topPairsHTML(6, false);
  $('pairs').querySelectorAll('[data-pair]').forEach((b) => (b.onclick = () => { setCompare(b.dataset.pair.split(',')); $('compare').scrollIntoView({ behavior: 'smooth' }); }));
}

const TOTALS = ['deaths_all', 'deaths_all_excl_infant'];
const PATTERNS = [
  ['stayed_up', 'Rose with the pandemic and stayed up', 'Peaked in 2020–21 and remain at least 5% above 2015–2019.'],
  ['rising_other', 'Rising without a pandemic spike', 'Up 10% or more with little change in 2020–21, so something other than the pandemic is likely involved.'],
  ['returned', 'Spiked, then came back', 'Peaked in 2020–21 and are now within 5% of 2015–2019.'],
  ['steady', 'Little change', 'Within 5% of 2015–2019 at the peak and now.'],
  ['lower', 'Lower than before', 'At least 5% below the 2015–2019 average.'],
];

function renderShift() {
  const rows = (rel.pandemic_shift || []).filter((d) => filtered.some((m) => m.id === d.id));
  if (!rows.length) { $('shift').innerHTML = '<p class="note">No measures match your filters.</p>'; return; }
  const all = rows.flatMap((d) => [d.pct, d.pandemic_peak_pct ?? 0]);
  const lo = Math.min(-15, ...all) * 1.1, hi = Math.max(15, ...all) * 1.1;
  const X = (v) => ((v - lo) / (hi - lo)) * 100;
  const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v)) + '%';
  $('shift').innerHTML = PATTERNS.map(([key, title, desc]) => {
    const g = rows.filter((d) => d.pattern === key);
    if (!g.length) return '';
    return `<div class="shiftgroup"><div class="shifthead"><div><h4>${esc(title)}</h4><p class="note">${esc(desc)}</p></div>
        ${(() => { const ids = g.map((d) => d.id).filter((id) => !TOTALS.includes(id));   // totals overwhelm causes; leave them out
          return ids.length ? `<button type="button" data-group="${ids.join(',')}">${ids.length > MAX_COMPARE ? `Chart the top ${MAX_COMPARE}` : ids.length === 1 ? 'Chart this' : 'Chart these'}</button>` : ''; })()}</div>
      ${g.map((d) => {
        const pk = d.pandemic_peak_pct ?? 0, a = Math.min(pk, d.pct), b = Math.max(pk, d.pct);
        return `<div class="shiftrow" title="${esc(nameOf(d.id))}: ${fmt(d.pre_avg)} a year in 2015–2019, ${fmt(d.recent_avg)} in ${esc(d.recent_years)}">
          <button type="button" class="linkish" data-id="${d.id}">${esc(nameOf(d.id))}${TOTALS.includes(d.id) ? '<small> (all causes)</small>' : ''}</button>
          <div class="dumb" role="img" aria-label="${esc(nameOf(d.id))}: ${sign(pk)} at the ${d.pandemic_peak_year} peak, ${sign(d.pct)} in ${esc(d.recent_years)}, compared with 2015 to 2019">
            <span class="zero" style="left:${X(0)}%"></span>
            <span class="span" style="left:${X(a)}%;width:${X(b) - X(a)}%"></span>
            <span class="pk" style="left:${X(pk)}%"></span><span class="now" style="left:${X(d.pct)}%"></span>
          </div>
          <span class="val">${sign(d.pct)}<small>peak ${sign(pk)}</small></span></div>`;
      }).join('')}</div>`;
  }).join('');
  $('shift').querySelectorAll('[data-group]').forEach((b) => (b.onclick = () => { setCompare(b.dataset.group.split(',')); $('compare').scrollIntoView({ behavior: 'smooth' }); }));
  $('shift').querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => selectMeasure(b.dataset.id)));
}

function renderCompare() {
  const mode = document.querySelector('input[name=cmode]:checked').value;
  const avail = filtered.filter((m) => m.headline?.latest);
  $('picker').innerHTML = avail.map((m) => {
    const c = compare.find((x) => x.id === m.id);
    return `<label><input type="checkbox" value="${m.id}" ${c ? 'checked' : ''} ${!c && compare.length >= MAX_COMPARE ? 'disabled' : ''}>
      <span class="sw" style="background:${c ? css(SLOTS[c.slot]) : 'transparent'}"></span>
      <span>${esc(m.short_label)}<br><small>${esc(m.headline.label)}</small></span></label>`;
  }).join('') || '<p class="note">No measures match your filters.</p>';
  $('picker').querySelectorAll('input').forEach((i) => (i.onchange = () => (i.checked ? (addCompare(i.value), renderCompare()) : removeCompare(i.value))));

  const chosenM = compare.map((c) => ({ ...c, m: measures.find((x) => x.id === c.id) })).filter((c) => c.m);
  $('chips').innerHTML = chosenM.map((c) => `<span class="chip"><i style="background:${css(SLOTS[c.slot])}"></i>${esc(c.m.short_label)}
    <button type="button" data-remove="${c.id}" aria-label="Remove ${esc(c.m.short_label)}">×</button></span>`).join('') ||
    '<span class="note">Nothing on the chart yet.</span>';
  $('chips').querySelectorAll('[data-remove]').forEach((b) => (b.onclick = () => removeCompare(b.dataset.remove)));

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
  $('legend').innerHTML = '';   // the chips above the chart carry each measure's color
  if (!series.length) {
    $('comparechart').innerHTML = '<p class="note empty">Add a measure from the suggestions, or chart one of the groups below.</p>';
    $('comparenote').textContent = ''; $('comparetable').innerHTML = '';
  } else if (mode === 'index' && base == null) {
    $('comparechart').innerHTML = '<p class="note empty">These measures have no year in common, so they can’t be indexed. Switch to counts.</p>';
  } else {
    lineChart($('comparechart'), series, { height: 340, indexed: mode === 'index' });
    $('comparenote').textContent = mode === 'index'
      ? `Each line shows the count as a share of its ${base} value. 120 means 20% more deaths than in ${base}. Hollow points are provisional.`
      : 'Counts on one scale. Large causes flatten small ones; switch to indexed to compare change. Hollow points are provisional.';
    const yrs = [...new Set(series.flatMap((s) => s.points.map((p) => p.year)))].sort();
    $('comparetable').innerHTML = `<table><thead><tr><th scope="col">Year</th>${series.map((s) => `<th scope="col">${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${
      yrs.map((y) => `<tr><td>${y}</td>${series.map((s) => { const p = s.points.find((q) => q.year === y); return `<td>${p?.withheld ? 'Withheld' : fmt(p?.value == null ? null : Math.round(p.value * 10) / 10)}</td>`; }).join('')}</tr>`).join('')}</tbody></table>`;
  }
  renderSuggestions(); renderShift(); renderPairs();
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
    [meta, catalog, themes, reports, methods, rel] = await Promise.all(['meta.json', 'catalog.json', 'themes.json', 'reports.json', 'methods.json', 'relationships.json'].map(getJSON));
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
  const heldIds = measures.filter((m) => pointsOf(m).some((p) => p.withheld)).map((m) => m.id);
  $('metrics').innerHTML = `
    <div class="metric"><span>Measures with data</span><strong>${active}</strong><small>of ${measures.length} defined; ${measures.length - active} waiting on table mapping</small></div>
    <div class="metric"><span>Values traced to a report page</span><strong>${fmt(meta.counts.rows)}</strong><small>From ${reports.filter((r) => r.used_by.length).length} of ${meta.counts.reports} DOH reports so far</small></div>
    <div class="metric"><span>Values withheld</span><strong>${meta.counts.withheld}</strong><small>${errors} open data check${errors === 1 ? '' : 's'}.${heldIds.length ? ` <a href="#" data-measure="${heldIds[0]}">See ${esc(nameOf(heldIds[0]))}</a>` : ''}</small></div>`;
  $('rules').innerHTML = (methods.rules || []).map((r) => `<dt>${esc(r.problem)}</dt><dd>${esc(r.rule)}</dd>`).join('');
  $('download').onclick = () => { location.href = 'data/downloads/indicators.csv'; };
  // a starting comparison: the deaths-of-despair measures that have data
  (themes.find((t) => t.id === 'deaths_of_despair')?.active || []).concat(['deaths_falls']).forEach(addCompare);
  $('openchecks').innerHTML = errors
    ? `<p>${errors} check${errors === 1 ? ' is' : 's are'} open. The affected value${meta.counts.withheld === 1 ? ' is' : 's are'} withheld: ${heldIds.map((id) => `<a href="#" data-measure="${id}">${esc(nameOf(id))}</a>`).join(', ')}.</p>`
    : '<p>All checks pass on the tables read so far.</p>';
  document.addEventListener('click', (e) => { const l = e.target.closest('[data-measure]'); if (l) { e.preventDefault(); selectMeasure(l.dataset.measure); } });
  renderReports(); apply();
  let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { if (view === 'compare') renderCompare(); else renderDetail(); }, 150); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { renderDetail(); if (view === 'compare') renderCompare(); });
}
init();
