/* Mosquito Alert live map — static client.
 * Data files are produced by ../fetch.py on a schedule; see README.md. */
'use strict';

const DATA = 'data/';
const DAY = 1440; // minutes
const META_POLL_MS = 5 * 60 * 1000;
const FEED_PAGE = 50;
const FRESH_MIN = 2 * DAY; // "new" highlight window

const CATS = [
  { k: 'albo', label: 'Tiger mosquito', sub: 'Ae. albopictus' },
  { k: 'aegypti', label: 'Yellow fever mosquito', sub: 'Ae. aegypti' },
  { k: 'japkor', label: 'Asian bush / Korean', sub: 'Ae. japonicus, koreicus' },
  { k: 'culex', label: 'Common mosquito', sub: 'Culex' },
  { k: 'othermosq', label: 'Other mosquitoes', sub: 'Anopheles, Culiseta, …' },
  { k: 'notmosq', label: 'Not a mosquito', sub: 'other insects' },
  { k: 'unid', label: 'Unidentified', sub: 'no usable photo' },
];
const CAT_IDX = Object.fromEntries(CATS.map((c, i) => [c.k, i]));
const KINDS = ['obs', 'bites', 'sites'];
const KIND_LABEL = { obs: 'Mosquito reports', bites: 'Bites', sites: 'Breeding sites' };
const SITE_LABEL = {
  storm_drain: 'Storm drain', basin: 'Basin', bucket: 'Bucket', fountain: 'Fountain',
  small_container: 'Small container', well: 'Well', other: 'Other site',
};
const RANGES = { '1d': 1, '3d': 3, '7d': 7, '30d': 30, '90d': 90, '1y': 365, all: null };

// ---------- state ----------
const S = {
  range: '30d', from: null, to: null, // custom range in minutes (from inclusive, to exclusive)
  layers: { obs: true, bites: false, sites: false },
  cats: new Set(CATS.map(c => c.k)),
  mode: 'points',
  inView: true,
  feedLimit: FEED_PAGE,
};
let meta = null;
let recent = { obs: [], bites: [], sites: [] };
const hist = {};        // kind -> decoded columnar arrays
const loading = {};     // kind -> promise
const detailByIdx = { obs: new Map(), bites: new Map(), sites: new Map() };
const idsCache = {};    // `${kind}-${year}` -> promise<string[]>
let taxa = new Map();
let map;
let mapReady = false;
let popup;

const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
  return e;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = n => n.toLocaleString('en-US');
const nowMin = () => Math.floor(Date.now() / 60000);
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function ago(min) {
  const d = nowMin() - min;
  if (d < 1) return 'just now';
  if (d < 60) return `${d} min ago`;
  if (d < DAY) return `${Math.floor(d / 60)} h ago`;
  if (d < 30 * DAY) return `${Math.floor(d / DAY)} d ago`;
  return new Date(min * 60000).toISOString().slice(0, 10);
}
const isoMin = s => Math.floor(Date.parse(s) / 60000);
const fmtDate = min => new Date(min * 60000).toISOString().slice(0, 10);
const fmtDateTime = min => new Date(min * 60000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function photoUrl(name) { return /^https?:/.test(name) ? name : meta.photo_prefix + name; }
function thumbUrl(name, w, h) {
  const u = photoUrl(name).replace(/^https?:\/\//, '');
  return `https://images.weserv.nl/?url=${encodeURIComponent(u)}&w=${w}&h=${h}&fit=cover&output=webp`;
}
// fall back to the original photo if the resizing proxy fails
window.thumbFallback = img => { if (img.dataset.full && img.src !== img.dataset.full) img.src = img.dataset.full; };

// ---------- time window ----------
function windowMin() {
  if (S.range === 'custom') return [S.from ?? 0, S.to ?? nowMin() + DAY];
  const days = RANGES[S.range];
  return [days == null ? 0 : nowMin() - days * DAY, nowMin() + DAY];
}

// ---------- data loading ----------
async function getJSON(path, bust) {
  // bust === true: always revalidate (tiny meta file); otherwise a per-snapshot version key
  const v = bust === true ? Date.now() : bust;
  const url = DATA + path + (v ? `?v=${encodeURIComponent(v)}` : '');
  const r = await fetch(url, bust === true ? { cache: 'no-store' } : {});
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

function decodeHist(kind, h) {
  const n = h.n;
  const t = new Int32Array(n), lat = new Float32Array(n), lon = new Float32Array(n);
  const c = new Uint8Array(n);
  let acc = h.t0;
  for (let i = 0; i < n; i++) {
    acc += h.dt[i]; t[i] = acc;
    lat[i] = h.lat[i] / 1e4; lon[i] = h.lon[i] / 1e4;
  }
  const out = { n, t, lat, lon, c };
  if (kind === 'obs') {
    out.tx = Uint16Array.from(h.tx);
    for (let i = 0; i < n; i++) {
      const tx = taxa.get(h.tx[i]);
      c[i] = tx ? CAT_IDX[tx.cat] : CAT_IDX.unid;
    }
  } else if (kind === 'sites') {
    out.st = Uint8Array.from(h.st); out.w = Uint8Array.from(h.w);
  }
  return out;
}

function toGeoJSON(kind, h) {
  const features = new Array(h.n);
  for (let i = 0; i < h.n; i++) {
    features[i] = {
      type: 'Feature', id: i,
      geometry: { type: 'Point', coordinates: [h.lon[i], h.lat[i]] },
      properties: { t: h.t[i], c: h.c[i] },
    };
  }
  return { type: 'FeatureCollection', features };
}

function loadKind(kind) {
  if (!loading[kind]) {
    loading[kind] = getJSON(`hist-${kind}.json`, meta.generated_at).then(raw => {
      hist[kind] = decodeHist(kind, raw);
      indexDetails(kind);
      if (mapReady) setSource(kind);
      updateAll();
    }).catch(e => { delete loading[kind]; showError(e); });
  }
  return loading[kind];
}

function indexDetails(kind) {
  detailByIdx[kind] = new Map(recent[kind].map(d => [d.i, d]));
}

async function loadMeta(initial) {
  const m = await getJSON('meta.json', true);
  if (!initial && meta && m.generated_at === meta.generated_at) return false;
  meta = m;
  taxa = new Map(meta.taxa.map(t => [t.id, t]));
  return true;
}

async function refresh() {
  try {
    if (!(await loadMeta(false))) return renderFresh();
    // fetch everything for the new snapshot first, then swap at once so
    // detail indices always match the history arrays they point into
    const v = meta.generated_at;
    const loaded = KINDS.filter(k => hist[k]);
    const [rec, ...raws] = await Promise.all([getJSON('recent.json', v), ...loaded.map(k => getJSON(`hist-${k}.json`, v))]);
    recent = rec;
    loaded.forEach((k, j) => { hist[k] = decodeHist(k, raws[j]); loading[k] = Promise.resolve(); });
    for (const k of Object.keys(idsCache)) delete idsCache[k];
    KINDS.forEach(indexDetails);
    if (mapReady) loaded.forEach(setSource);
    renderFresh();
    updateCounts();
  } catch (e) { console.warn('refresh failed', e); }
}

function showError(e) {
  console.error(e);
  $('#fresh-text').textContent = `Could not load data: ${e.message}`;
}

// ---------- map ----------
function basemap() {
  const dark = matchTheme() === 'dark';
  return `https://basemaps.cartocdn.com/gl/${dark ? 'dark-matter' : 'positron'}-gl-style/style.json`;
}
function matchTheme() {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function catColorExpr() {
  return ['match', ['get', 'c'], ...CATS.flatMap((c, i) => [i, cssVar(`--c-${c.k}`)]), '#888'];
}

function heatRamp() {
  // sequential blue ramp (light -> dark), transparent at zero
  const dark = matchTheme() === 'dark';
  const steps = dark
    ? ['#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb']
    : ['#cde2fb', '#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'];
  return ['interpolate', ['linear'], ['heatmap-density'],
    0, dark ? 'rgba(16,66,129,0)' : 'rgba(205,226,251,0)', 0.08, steps[0], 0.25, steps[1], 0.45, steps[2], 0.65, steps[3], 0.85, steps[4], 1, steps[5]];
}

const RADIUS = (base) => ['interpolate', ['linear'], ['zoom'], 2, base * 0.6, 6, base, 10, base * 1.6, 15, base * 2.6];

function addLayers() {
  const surface = cssVar('--surface');
  for (const k of KINDS) {
    if (!map.getSource(k)) map.addSource(k, { type: 'geojson', data: hist[k] ? toGeoJSON(k, hist[k]) : { type: 'FeatureCollection', features: [] } });
  }
  // breeding sites: hollow rings
  map.addLayer({ id: 'sites', type: 'circle', source: 'sites', paint: {
    'circle-radius': RADIUS(3), 'circle-color': 'rgba(0,0,0,0)',
    'circle-stroke-color': cssVar('--c-sites'), 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 3, 1.2, 10, 2.2],
  } });
  // bites: small filled dots
  map.addLayer({ id: 'bites', type: 'circle', source: 'bites', paint: {
    'circle-radius': RADIUS(2.4), 'circle-color': cssVar('--c-bites'), 'circle-opacity': 0.8,
    'circle-stroke-color': surface, 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0, 9, 1],
  } });
  map.addLayer({ id: 'obs-heat', type: 'heatmap', source: 'obs', paint: {
    'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 2, 6, 8, 16, 12, 28],
    'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 10, 1.6],
    'heatmap-color': heatRamp(),
    'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.9, 13, 0],
  } });
  map.addLayer({ id: 'obs', type: 'circle', source: 'obs', layout: { 'circle-sort-key': ['get', 't'] }, paint: {
    'circle-radius': RADIUS(3.2), 'circle-color': catColorExpr(), 'circle-opacity': 0.88,
    'circle-stroke-color': surface, 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 0.3, 9, 1.2],
  } });
  // fresh reports get a ring and sit on top
  map.addLayer({ id: 'obs-fresh', type: 'circle', source: 'obs', paint: {
    'circle-radius': RADIUS(5), 'circle-color': catColorExpr(), 'circle-opacity': 1,
    'circle-stroke-color': cssVar('--text'), 'circle-stroke-width': 1.6,
  } });
  applyFilters();
}

function setSource(kind) {
  const src = map.getSource(kind);
  if (src && hist[kind]) src.setData(toGeoJSON(kind, hist[kind]));
}

function applyFilters() {
  if (!mapReady) return;
  const [from, to] = windowMin();
  const time = [['>=', ['get', 't'], from], ['<', ['get', 't'], to]];
  const cats = ['in', ['get', 'c'], ['literal', [...S.cats].map(k => CAT_IDX[k])]];
  const fresh = ['>=', ['get', 't'], Math.max(from, nowMin() - FRESH_MIN)];
  map.setFilter('obs', ['all', ...time, cats]);
  map.setFilter('obs-heat', ['all', ...time, cats]);
  map.setFilter('obs-fresh', ['all', ...time, cats, fresh]);
  map.setFilter('bites', ['all', ...time]);
  map.setFilter('sites', ['all', ...time]);
  const vis = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  const heat = S.mode === 'heat';
  if (heat && hist.obs) {
    // scale intensity with the number of reports in range so "All time" doesn't saturate
    const n = Math.max(1, lowerBound(hist.obs.t, to) - lowerBound(hist.obs.t, from));
    const f = Math.min(1.5, Math.max(0.02, 20 / Math.sqrt(n)));
    map.setPaintProperty('obs-heat', 'heatmap-intensity', ['interpolate', ['linear'], ['zoom'], 2, 0.5 * f, 10, 2 * f]);
  }
  vis('obs', S.layers.obs);
  vis('obs-fresh', S.layers.obs);
  vis('obs-heat', S.layers.obs && heat);
  vis('bites', S.layers.bites);
  vis('sites', S.layers.sites);
  const fade = heat ? ['interpolate', ['linear'], ['zoom'], 9, 0, 11.5, 0.88] : 0.88;
  map.setPaintProperty('obs', 'circle-opacity', fade);
  map.setPaintProperty('obs', 'circle-stroke-opacity', heat ? ['interpolate', ['linear'], ['zoom'], 9, 0, 11.5, 1] : 1);
  map.setPaintProperty('obs-fresh', 'circle-opacity', heat ? ['interpolate', ['linear'], ['zoom'], 9, 0, 11.5, 1] : 1);
  map.setPaintProperty('obs-fresh', 'circle-stroke-opacity', heat ? ['interpolate', ['linear'], ['zoom'], 9, 0, 11.5, 1] : 1);
}

function initMap() {
  const h = parseHash();
  map = new maplibregl.Map({
    container: 'map', style: basemap(),
    center: h.center || [5, 44], zoom: h.zoom ?? 4.2,
    attributionControl: { compact: true },
    hash: false, maxPitch: 0, dragRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: false }, fitBoundsOptions: { maxZoom: 11 } }), 'top-right');
  map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
  map.on('style.load', () => { mapReady = true; addLayers(); });
  map.on('moveend', () => { writeHash(); if (S.inView) updateCounts(); });
  for (const id of ['obs', 'obs-fresh', 'bites', 'sites']) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('click', onMapClick);
  const ld = el('div', { class: 'loading', id: 'loading' }, 'Loading reports…');
  $('#map').append(ld);
}

// ---------- popups ----------
function onMapClick(e) {
  const pad = 7;
  const box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
  const layers = ['obs-fresh', 'obs', 'bites', 'sites'].filter(id => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
  const feats = map.queryRenderedFeatures(box, { layers });
  if (!feats.length) return;
  const seen = new Set();
  const items = [];
  for (const f of feats) {
    const kind = f.source;
    const key = kind + f.id;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind, i: f.id, t: f.properties.t });
  }
  items.sort((a, b) => b.t - a.t);
  const first = items[0];
  openPopup(items, [hist[first.kind].lon[first.i], hist[first.kind].lat[first.i]]);
}

function openPopup(items, lngLat) {
  const MAX = 6;
  const wrap = el('div', { class: 'pop' });
  for (const it of items.slice(0, MAX)) wrap.append(popupItem(it.kind, it.i));
  if (items.length > MAX) wrap.append(el('div', { class: 'moreitems' }, `+ ${items.length - MAX} more reports here — zoom in to separate them`));
  if (popup) popup.remove();
  popup = new maplibregl.Popup({ maxWidth: '320px', offset: 10, focusAfterOpen: false }).setLngLat(lngLat).setDOMContent(wrap).addTo(map);
}

function taxonTitle(txId) {
  const tx = taxa.get(txId);
  if (!tx) return { html: 'Unidentified', common: 'no usable photo / not classified', cat: 'unid' };
  const name = tx.it ? `<i>${esc(tx.name)}</i>` : esc(tx.name);
  let common = tx.common;
  if (!common && tx.cat === 'notmosq') common = 'not a mosquito';
  return { html: name, common, cat: tx.cat };
}

function popupItem(kind, i) {
  const h = hist[kind];
  const d = detailByIdx[kind].get(i);
  const t = h.t[i];
  const box = el('div', { class: 'it' });
  let html = '';
  const photos = d && d.ph && d.ph.length ? (d.ip ? [d.ip, ...d.ph.filter(p => p !== d.ip)] : d.ph) : [];
  if (photos.length) {
    html += '<div class="ph">' + photos.slice(0, 2).map(p =>
      `<a href="${esc(photoUrl(p))}" target="_blank" rel="noopener"><img loading="lazy" alt="Report photo" src="${esc(thumbUrl(p, 560, 340))}" data-full="${esc(photoUrl(p))}" onerror="thumbFallback(this)"></a>`).join('') + '</div>';
  }
  const isNew = nowMin() - t < FRESH_MIN ? ' <span class="badge new">NEW</span>' : '';
  if (kind === 'obs') {
    const tt = taxonTitle(h.tx[i]);
    html += `<div class="tt"><span class="sw" style="background:var(--c-${tt.cat})"></span><span>${tt.html}</span>${isNew}</div>`;
    if (tt.common) html += `<div class="cn">${esc(tt.common)}</div>`;
    if (d) {
      const src = d.src === 'ai' ? '<span class="badge ai">AI</span>' : d.src ? `<span class="badge ex">${esc(d.src === 'expert' ? 'Expert' : d.src)}</span>` : '';
      const conf = d.cl ? `${esc(d.cl)}${d.cf != null ? ` (${Math.round(d.cf * 100)}%)` : ''}` : '';
      if (src || conf) html += `<div class="kv"><div>${src} ${conf}${d.na ? ` · ${d.na} expert annotation${d.na > 1 ? 's' : ''}` : ''}</div></div>`;
      if (d.pn) html += `<div class="pn">${esc(d.pn)}</div>`;
    }
  } else if (kind === 'bites') {
    html += `<div class="tt"><span class="sw sw-bites"></span><span>Bite report${d && d.n ? ` · ${d.n} bite${d.n > 1 ? 's' : ''}` : ''}</span>${isNew}</div>`;
    if (d && d.bp && Object.keys(d.bp).length) html += `<div class="cn">${Object.entries(d.bp).map(([k, v]) => `${esc(k.replace('_', ' '))}: ${v}`).join(', ')}</div>`;
  } else {
    const st = meta.site_types[h.st[i]];
    html += `<div class="tt"><span class="sw sw-sites"></span><span>Breeding site · ${esc(SITE_LABEL[st] || st)}</span>${isNew}</div>`;
    const w = h.w[i];
    const bits = [w === 1 ? 'has water' : w === 0 ? 'no water' : null];
    if (d) {
      if (d.lv != null) bits.push(d.lv ? 'larvae seen' : 'no larvae');
      if (d.nm) bits.push('mosquitoes nearby');
    }
    html += `<div class="cn">${bits.filter(Boolean).join(' · ')}</div>`;
  }
  html += '<div class="kv">';
  if (d && d.pl) html += `<div>📍 ${esc(d.pl)}</div>`;
  html += `<div>🕒 ${d && d.c ? `${esc(d.c.replace('T', ' '))} local · ` : ''}received ${esc(ago(t))}${nowMin() - t >= 30 * DAY ? '' : ` (${esc(fmtDateTime(t))})`}</div>`;
  if (d && d.env) html += `<div>${d.env === 'indoors' ? '🏠 Indoors' : '🌳 Outdoors'}</div>`;
  if (d && d.no) html += `<div>“${esc(d.no)}”</div>`;
  html += '</div>';
  box.innerHTML = html;
  const ln = el('div', { class: 'ln' });
  const coord = `${h.lat[i].toFixed(4)}, ${h.lon[i].toFixed(4)}`;
  ln.append(el('span', {}, coord));
  const rec = el('a', { target: '_blank', rel: 'noopener' }, d && d.s ? `Record ${d.s}` : 'Full record');
  ln.append(rec);
  box.append(ln);
  recordUrl(kind, i, d).then(u => { if (u) rec.href = u; else rec.remove(); });
  return box;
}

const API_PATH = { obs: 'observations', bites: 'bites', sites: 'breeding-sites' };
async function recordUrl(kind, i, d) {
  let uuid = d && d.u;
  if (!uuid) {
    // uuids for older reports live in per-year files, aligned with history order
    const h = hist[kind];
    const year = new Date(h.t[i] * 60000).getUTCFullYear();
    const key = `${kind}-${year}`;
    idsCache[key] ||= getJSON(`ids/${key}.json`, meta.generated_at);
    try {
      const ids = await idsCache[key];
      uuid = ids[i - lowerBound(h.t, Date.UTC(year, 0, 1) / 60000)];
    } catch { return null; }
  }
  return uuid ? `${meta.api}/${API_PATH[kind]}/${uuid}/` : null;
}

// ---------- counting & chart ----------
function inBoundsFn() {
  if (!S.inView || !map) return () => true;
  const b = map.getBounds();
  const w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
  if (e - w >= 360) return (lat) => lat >= s && lat <= n;
  const W = ((w + 540) % 360) - 180, E = ((e + 540) % 360) - 180;
  return W <= E
    ? (lat, lon) => lat >= s && lat <= n && lon >= W && lon <= E
    : (lat, lon) => lat >= s && lat <= n && (lon >= W || lon <= E);
}

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

function updateCounts() {
  const [from, to] = windowMin();
  const inB = inBoundsFn();
  const scope = S.inView ? 'in view' : 'total';
  $('#cat-scope').textContent = `${S.range === 'all' ? 'all time' : 'in range'}, ${scope}`;
  for (const k of KINDS) {
    const h = hist[k];
    const out = $(`#n-${k}`);
    if (!h) { out.textContent = S.layers[k] ? '…' : ''; continue; }
    let n = 0;
    const a = lowerBound(h.t, from), b = lowerBound(h.t, to);
    const catOk = CATS.map(c => k !== 'obs' || S.cats.has(c.k));
    for (let i = a; i < b; i++) if (catOk[h.c[i]] && inB(h.lat[i], h.lon[i])) n++;
    out.textContent = fmtN(n);
  }
  const h = hist.obs;
  const counts = new Array(CATS.length).fill(0);
  if (h) {
    const a = lowerBound(h.t, from), b = lowerBound(h.t, to);
    for (let i = a; i < b; i++) if (inB(h.lat[i], h.lon[i])) counts[h.c[i]]++;
  }
  CATS.forEach((c, i) => { const n = $(`#cat-n-${c.k}`); if (n) n.textContent = h ? fmtN(counts[i]) : ''; });
  renderChart(from, to, inB);
  renderFeed(from, to, inB);
}

function renderChart(from, to, inB) {
  const box = $('#chart');
  const h = hist.obs;
  if (!h || !h.n) { box.innerHTML = ''; return; }
  const a = lowerBound(h.t, from), b = lowerBound(h.t, to);
  const now = nowMin();
  const start = Math.max(from, h.t[0]);
  const end = Math.min(to, now);
  const span = end - start;
  // bin size: hours for <=3d, days up to ~6 months, weeks up to ~3y, else months
  let unit, step;
  if (span <= 3 * DAY) { unit = 'hour'; step = 60; }
  else if (span <= 200 * DAY) { unit = 'day'; step = DAY; }
  else if (span <= 3 * 365 * DAY) { unit = 'week'; step = 7 * DAY; }
  else { unit = 'month'; step = null; }
  const binOf = unit === 'month'
    ? (t) => { const d = new Date(t * 60000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }
    : (t) => Math.floor(t / step);
  const b0 = binOf(start), b1 = binOf(end);
  const nb = b1 - b0 + 1;
  const bins = new Array(nb).fill(0);
  const catOk = CATS.map(c => S.cats.has(c.k));
  for (let i = a; i < b; i++) {
    if (!catOk[h.c[i]] || !inB(h.lat[i], h.lon[i])) continue;
    const k = binOf(h.t[i]) - b0;
    if (k >= 0 && k < nb) bins[k]++;
  }
  const binStart = k => unit === 'month'
    ? Date.UTC(Math.floor((b0 + k) / 12), (b0 + k) % 12, 1) / 60000
    : (b0 + k) * step;
  const total = bins.reduce((s, x) => s + x, 0);
  $('#chart-title').textContent = `Mosquito reports per ${unit} · ${fmtN(total)}`;

  const W = box.clientWidth || 340, H = 120, padL = 30, padB = 18, padT = 6;
  const max = Math.max(1, ...bins);
  const nice = niceMax(max);
  const bw = (W - padL) / nb;
  const gap = bw > 4 ? 2 : bw > 2 ? 1 : 0;
  const y = v => padT + (H - padB - padT) * (1 - v / nice);
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Reports per ${unit}">`;
  for (const v of [0, nice / 2, nice]) {
    svg += `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--${v ? 'grid' : 'axis'})" stroke-width="1"/>`;
    svg += `<text x="${padL - 5}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" fill="var(--muted)">${fmtN(v)}</text>`;
  }
  const r = Math.min(4, Math.max(0, (bw - gap) / 2));
  bins.forEach((v, k) => {
    if (!v) return;
    const x = padL + k * bw + gap / 2, w = Math.max(0.8, bw - gap), top = y(v), base = y(0);
    const hh = base - top;
    const rr = Math.min(r, hh);
    svg += `<path d="M${x},${base}V${top + rr}q0,${-rr} ${rr},${-rr}h${w - 2 * rr}q${rr},0 ${rr},${rr}V${base}Z" fill="var(--bar)"/>`;
  });
  // x labels: first and last bin
  const lab = k => unit === 'hour' ? new Date(binStart(k) * 60000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' })
    : unit === 'month' ? new Date(binStart(k) * 60000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', timeZone: 'UTC' })
    : new Date(binStart(k) * 60000).toLocaleDateString(undefined, { year: span > 300 * DAY ? 'numeric' : undefined, month: 'short', day: 'numeric', timeZone: 'UTC' });
  svg += `<text x="${padL}" y="${H - 4}" font-size="10" fill="var(--muted)">${esc(lab(0))}</text>`;
  svg += `<text x="${W}" y="${H - 4}" font-size="10" text-anchor="end" fill="var(--muted)">${esc(lab(nb - 1))}</text>`;
  svg += `<rect class="hit" x="${padL}" y="0" width="${W - padL}" height="${H - padB}" fill="transparent"/>`;
  svg += '</svg>';
  box.innerHTML = svg;
  const tip = el('div', { class: 'tip', hidden: true });
  box.append(tip);
  const svgEl = box.querySelector('svg');
  const hl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  hl.setAttribute('fill', 'var(--wash)'); hl.setAttribute('y', 0); hl.setAttribute('height', H - padB); hl.style.display = 'none';
  svgEl.insertBefore(hl, svgEl.firstChild);
  const move = ev => {
    const rect = svgEl.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (W / rect.width);
    const k = Math.floor((px - padL) / bw);
    if (k < 0 || k >= nb) { tip.hidden = true; hl.style.display = 'none'; return; }
    hl.setAttribute('x', padL + k * bw); hl.setAttribute('width', bw); hl.style.display = '';
    tip.hidden = false;
    tip.innerHTML = `${esc(lab(k))}${unit === 'week' ? ' (week)' : ''}: <b>${fmtN(bins[k])}</b>`;
    const cx = (padL + (k + 0.5) * bw) * (rect.width / W);
    tip.style.left = `${Math.min(Math.max(cx, 70), rect.width - 70)}px`;
  };
  svgEl.addEventListener('pointermove', move);
  svgEl.addEventListener('pointerleave', () => { tip.hidden = true; hl.style.display = 'none'; });
}

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return Math.max(2, m * p);
  return v;
}

// ---------- feed ----------
function feedItems(from, to, inB) {
  const all = [];
  for (const k of KINDS) {
    if (!S.layers[k]) continue;
    for (const d of recent[k]) {
      const t = isoMin(d.r);
      if (t < from || t >= to) continue;
      if (k === 'obs') {
        const tx = taxa.get(d.tx);
        if (!S.cats.has(tx ? tx.cat : 'unid')) continue;
      }
      if (!inB(d.la, d.lo)) continue;
      all.push({ k, d, t });
    }
  }
  all.sort((a, b) => b.t - a.t);
  return all;
}

function renderFeed(from, to, inB) {
  const items = feedItems(from, to, inB);
  const ol = $('#feed');
  ol.replaceChildren();
  $('#feed-count').textContent = items.length ? `${fmtN(items.length)}${S.inView ? ' in view' : ''}` : '';
  for (const { k, d, t } of items.slice(0, S.feedLimit)) ol.append(feedRow(k, d, t));
  $('#more').hidden = items.length <= S.feedLimit;
  const days = meta ? meta.detail_days : 30;
  const note = [];
  if (!items.length) note.push(Object.values(S.layers).some(Boolean) ? 'No reports match the current filters in this area.' : 'Turn on a layer to see reports.');
  if (from < nowMin() - days * DAY) note.push(`The feed covers the last ${days} days; older reports are on the map (click a dot).`);
  $('#feed-note').textContent = note.join(' ');
}

function feedRow(k, d, t) {
  let title, cat, img = null;
  const pic = d.ip || (d.ph && d.ph[0]);
  if (pic) img = el('img', { class: 'thumb', loading: 'lazy', alt: '', src: thumbUrl(pic, 112, 112), 'data-full': photoUrl(pic), onerror: e => thumbFallback(e.target) });
  if (k === 'obs') {
    const tx = taxa.get(d.tx);
    cat = tx ? tx.cat : 'unid';
    title = tx ? (tx.common || tx.name) : 'Unidentified';
    if (tx && tx.cat === 'notmosq' && !tx.common) title = `Not a mosquito (${tx.name})`;
  } else if (k === 'bites') {
    title = `Bite report${d.n ? ` · ${d.n}` : ''}`;
  } else {
    title = `Breeding site · ${SITE_LABEL[d.st] || d.st}`;
  }
  const dot = el('span', { class: k === 'obs' ? 'cd' : `cd sw sw-${k}`, style: k === 'obs' ? `background:var(--c-${cat})` : null });
  const meta2 = el('div', { class: 'm' }, el('span', { title: new Date(t * 60000).toLocaleString() }, ago(t)));
  if (nowMin() - t < FRESH_MIN) meta2.prepend(el('span', { class: 'badge new' }, 'NEW'));
  if (k === 'obs' && d.src) {
    meta2.append(el('span', { class: `badge ${d.src === 'ai' ? 'ai' : 'ex'}`, title: d.src === 'ai' ? 'Automatic identification, not yet validated by experts' : 'Validated by experts' }, d.src === 'ai' ? 'AI' : 'Expert'));
    if (d.cl) meta2.append(el('span', {}, d.cl));
  }
  if (k === 'obs' && d.tx && taxa.get(d.tx) && taxa.get(d.tx).common) {
    const tx = taxa.get(d.tx);
    meta2.append(el('i', {}, tx.name));
  }
  const li = el('li', { tabindex: 0 },
    img || el('div', { class: 'thumb', 'aria-hidden': 'true' }, k === 'bites' ? '🦟' : k === 'sites' ? '💧' : '?'),
    el('div', { class: 'fi' },
      el('div', { class: 't' }, dot, el('span', {}, title)),
      el('div', { class: 'p' }, d.pl || `${d.la.toFixed(3)}, ${d.lo.toFixed(3)}`),
      meta2));
  const go = () => {
    if (!hist[k]) return;
    map.flyTo({ center: [d.lo, d.la], zoom: Math.max(map.getZoom(), 12), speed: 1.6 });
    openPopup([{ kind: k, i: d.i, t }], [hist[k].lon[d.i], hist[k].lat[d.i]]);
  };
  li.addEventListener('click', go);
  li.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  return li;
}

// ---------- header freshness ----------
function renderFresh() {
  if (!meta) return;
  const gen = isoMin(meta.generated_at);
  const newest = Math.max(...KINDS.map(k => meta.kinds[k].newest || 0));
  const p = $('#fresh');
  p.classList.toggle('ok', nowMin() - gen < 60);
  $('#fresh-text').textContent = `Synced ${ago(gen)} · newest report ${ago(newest)} · ${fmtN(meta.kinds.obs.count)} mosquito reports`;
  p.title = `Snapshot ${meta.generated_at}; refreshed automatically every ~15 minutes`;
}

// ---------- controls ----------
function buildCats() {
  const box = $('#cats');
  for (const c of CATS) {
    const cb = el('input', { type: 'checkbox', checked: S.cats.has(c.k) });
    cb.addEventListener('change', () => { cb.checked ? S.cats.add(c.k) : S.cats.delete(c.k); syncControls(); update(); });
    const only = el('button', { class: 'only', title: `Show only ${c.label}`, onclick: e => {
      e.preventDefault(); S.cats = new Set([c.k]); syncControls(); update();
    } }, 'only');
    box.append(el('label', { class: 'row', 'data-cat': c.k }, cb,
      el('span', { class: 'sw', style: `background:var(--c-${c.k})` }),
      el('span', { class: 'lbl' }, c.label, el('small', {}, c.sub)), only,
      el('span', { class: 'num', id: `cat-n-${c.k}` })));
  }
}

function syncControls() {
  document.querySelectorAll('#ranges button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.r === S.range)));
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === S.mode)));
  document.querySelectorAll('[data-layer]').forEach(cb => { cb.checked = S.layers[cb.dataset.layer]; cb.closest('.row').classList.toggle('off', !cb.checked); });
  document.querySelectorAll('#cats .row').forEach(r => { const on = S.cats.has(r.dataset.cat); r.querySelector('input').checked = on; r.classList.toggle('off', !on); });
  const [from, to] = windowMin();
  $('#from').value = from > 0 ? fmtDate(from) : (hist.obs ? fmtDate(hist.obs.t[0]) : '');
  $('#to').value = S.range === 'custom' && S.to ? fmtDate(S.to - DAY) : fmtDate(nowMin());
}

function initControls() {
  document.querySelectorAll('#ranges button').forEach(b => b.addEventListener('click', () => {
    S.range = b.dataset.r; S.from = S.to = null; syncControls(); update();
  }));
  const custom = () => {
    const f = $('#from').value, t = $('#to').value;
    S.range = 'custom';
    S.from = f ? Date.parse(f + 'T00:00:00Z') / 60000 : null;
    S.to = t ? Date.parse(t + 'T00:00:00Z') / 60000 + DAY : null;
    syncControls(); update();
  };
  $('#from').addEventListener('change', custom);
  $('#to').addEventListener('change', custom);
  document.querySelectorAll('[data-layer]').forEach(cb => cb.addEventListener('change', () => {
    S.layers[cb.dataset.layer] = cb.checked;
    if (cb.checked && meta) loadKind(cb.dataset.layer);
    syncControls(); update();
  }));
  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => { S.mode = b.dataset.mode; syncControls(); update(); }));
  $('#inview').addEventListener('change', e => { S.inView = e.target.checked; update(); });
  $('#more').addEventListener('click', () => { S.feedLimit += FEED_PAGE; updateCounts(); });
  $('#theme').addEventListener('click', () => {
    const next = matchTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ma-theme', next); } catch {}
    restyle();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!document.documentElement.dataset.theme) restyle(); });
  let rz;
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(updateCounts, 150); });
}

function restyle() {
  if (!map) return;
  mapReady = false;
  map.setStyle(basemap(), { diff: false }); // style.load re-adds our layers with the new theme colors
  updateCounts();
}

function update() {
  S.feedLimit = FEED_PAGE;
  applyFilters();
  updateCounts();
  writeHash();
}
function updateAll() {
  const ld = $('#loading');
  if (ld) ld.hidden = KINDS.every(k => !S.layers[k] || hist[k]);
  syncControls();
  update();
}

// ---------- URL hash ----------
function parseHash() {
  const out = {};
  const q = new URLSearchParams(location.hash.slice(1));
  const m = (q.get('map') || '').split('/').map(Number);
  if (m.length === 3 && m.every(Number.isFinite)) { out.zoom = m[0]; out.center = [m[2], m[1]]; }
  const r = q.get('r');
  if (r && (r in RANGES)) S.range = r;
  else if (r && /^\d{4}-\d\d-\d\d_\d{4}-\d\d-\d\d$/.test(r)) {
    const [f, t] = r.split('_');
    S.range = 'custom'; S.from = Date.parse(f + 'T00:00:00Z') / 60000; S.to = Date.parse(t + 'T00:00:00Z') / 60000 + DAY;
  }
  if (q.has('l')) { const l = q.get('l').split(','); for (const k of KINDS) S.layers[k] = l.includes(k); }
  if (q.has('c')) { const c = q.get('c').split(',').filter(k => k in CAT_IDX); if (c.length) S.cats = new Set(c); }
  if (q.get('m') === 'heat') S.mode = 'heat';
  return out;
}
let hashT;
function writeHash() {
  clearTimeout(hashT);
  hashT = setTimeout(() => {
    const q = new URLSearchParams();
    if (map) { const c = map.getCenter(); q.set('map', `${map.getZoom().toFixed(2)}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`); }
    q.set('r', S.range === 'custom' ? `${fmtDate(S.from ?? 0)}_${fmtDate((S.to ?? nowMin()) - DAY)}` : S.range);
    q.set('l', KINDS.filter(k => S.layers[k]).join(','));
    if (S.cats.size !== CATS.length) q.set('c', [...S.cats].join(','));
    if (S.mode === 'heat') q.set('m', 'heat');
    history.replaceState(null, '', '#' + q.toString().replace(/%2F/g, '/').replace(/%2C/g, ','));
  }, 250);
}

// ---------- boot ----------
async function boot() {
  try { const t = localStorage.getItem('ma-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
  buildCats();
  initControls();
  initMap();
  syncControls();
  try {
    await loadMeta(true);
    renderFresh();
    const rec = getJSON('recent.json', meta.generated_at).then(r => { recent = r; KINDS.forEach(indexDetails); updateCounts(); });
    await Promise.all([rec, ...KINDS.filter(k => S.layers[k]).map(loadKind)]);
  } catch (e) { showError(e); }
  setInterval(refresh, META_POLL_MS);
  setInterval(() => { renderFresh(); }, 30 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

if (window.maplibregl) boot();
else addEventListener('DOMContentLoaded', boot);
