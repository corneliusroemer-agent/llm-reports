import { CAT_KEYS, DAY, KINDS, RANGES, type CatKey, type Kind, type RangeKey } from '../config';
import { fmtDate } from './format';

export type Mode = 'points' | 'heat';

export interface UiState {
  range: RangeKey | 'custom';
  from: number | null; // custom range, minutes (inclusive)
  to: number | null; // custom range, minutes (exclusive)
  layers: Record<Kind, boolean>;
  cats: Set<CatKey>;
  mode: Mode;
  inView: boolean;
}

export interface MapView { zoom: number; lat: number; lon: number }

export const defaultUi = (): UiState => ({
  range: '30d', from: null, to: null,
  layers: { obs: true, bites: false, sites: false },
  cats: new Set(CAT_KEYS),
  mode: 'points',
  inView: true,
});

const dayMin = (s: string) => Date.parse(s + 'T00:00:00Z') / 60000;

export function parseHash(hash: string): { ui: UiState; view: MapView | null } {
  const ui = defaultUi();
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  let view: MapView | null = null;
  const m = (q.get('map') || '').split('/').map(Number);
  if (m.length === 3 && m.every(Number.isFinite)) view = { zoom: m[0], lat: m[1], lon: m[2] };
  const r = q.get('r');
  if (r && r in RANGES) ui.range = r as RangeKey;
  else if (r && /^\d{4}-\d\d-\d\d_\d{4}-\d\d-\d\d$/.test(r)) {
    const [f, t] = r.split('_');
    ui.range = 'custom'; ui.from = dayMin(f); ui.to = dayMin(t) + DAY;
  }
  if (q.has('l')) { const l = q.get('l')!.split(','); for (const k of KINDS) ui.layers[k] = l.includes(k); }
  if (q.has('c')) {
    const c = q.get('c')!.split(',').filter((k): k is CatKey => (CAT_KEYS as string[]).includes(k));
    if (c.length) ui.cats = new Set(c);
  }
  if (q.get('m') === 'heat') ui.mode = 'heat';
  if (q.get('v') === 'all') ui.inView = false;
  return { ui, view };
}

export function buildHash(ui: UiState, view: MapView | null, now: number): string {
  const q = new URLSearchParams();
  if (view) q.set('map', `${view.zoom.toFixed(2)}/${view.lat.toFixed(4)}/${view.lon.toFixed(4)}`);
  q.set('r', ui.range === 'custom' ? `${fmtDate(ui.from ?? 0)}_${fmtDate((ui.to ?? now + DAY) - DAY)}` : ui.range);
  q.set('l', KINDS.filter(k => ui.layers[k]).join(','));
  if (ui.cats.size !== CAT_KEYS.length) q.set('c', [...ui.cats].join(','));
  if (ui.mode === 'heat') q.set('m', 'heat');
  if (!ui.inView) q.set('v', 'all');
  return '#' + q.toString().replace(/%2F/g, '/').replace(/%2C/g, ',');
}

export function timeWindow(ui: UiState, now: number): [number, number] {
  if (ui.range === 'custom') return [ui.from ?? 0, ui.to ?? now + DAY];
  const days = RANGES[ui.range];
  return [days == null ? 0 : now - days * DAY, now + DAY];
}
