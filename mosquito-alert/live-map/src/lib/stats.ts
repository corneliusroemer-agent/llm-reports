import { CATS, DAY, KINDS, type CatKey, type Kind } from '../config';
import type { Columns, Detail } from '../types';
import type { Store } from './store';
import { isoMin, lowerBound } from './format';

export interface Bounds { w: number; e: number; s: number; n: number }
export type InBounds = (lat: number, lon: number) => boolean;

export function inBoundsFn(b: Bounds | null): InBounds {
  if (!b) return () => true;
  const { s, n } = b;
  if (b.e - b.w >= 360) return lat => lat >= s && lat <= n;
  const W = ((b.w + 540) % 360) - 180, E = ((b.e + 540) % 360) - 180;
  return W <= E
    ? (lat, lon) => lat >= s && lat <= n && lon >= W && lon <= E
    : (lat, lon) => lat >= s && lat <= n && (lon >= W || lon <= E);
}

export function catMask(cats: Set<CatKey>): boolean[] {
  return CATS.map(c => cats.has(c.k));
}

export interface Counts {
  kinds: Partial<Record<Kind, number>>;
  cats: number[];
}

export function countAll(cols: Partial<Record<Kind, Columns>>, from: number, to: number, cats: Set<CatKey>, inB: InBounds): Counts {
  const ok = catMask(cats);
  const out: Counts = { kinds: {}, cats: new Array(CATS.length).fill(0) };
  for (const k of KINDS) {
    const h = cols[k];
    if (!h) continue;
    const a = lowerBound(h.t, from), b = lowerBound(h.t, to);
    let n = 0;
    for (let i = a; i < b; i++) {
      if (!inB(h.lat[i], h.lon[i])) continue;
      if (k === 'obs') { out.cats[h.c[i]]++; if (!ok[h.c[i]]) continue; }
      n++;
    }
    out.kinds[k] = n;
  }
  return out;
}

export type BinUnit = 'hour' | 'day' | 'week' | 'month';
export interface Bins { unit: BinUnit; values: number[]; starts: number[]; span: number }

export function binObs(h: Columns | undefined, from: number, to: number, now: number, cats: Set<CatKey>, inB: InBounds): Bins | null {
  if (!h || !h.n) return null;
  const start = Math.max(from, h.t[0]);
  const end = Math.min(to, now);
  const span = end - start;
  let unit: BinUnit, step = 0;
  if (span <= 3 * DAY) { unit = 'hour'; step = 60; }
  else if (span <= 200 * DAY) { unit = 'day'; step = DAY; }
  else if (span <= 3 * 365 * DAY) { unit = 'week'; step = 7 * DAY; }
  else unit = 'month';
  const binOf = unit === 'month'
    ? (t: number) => { const d = new Date(t * 60000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }
    : (t: number) => Math.floor(t / step);
  const b0 = binOf(start), nb = Math.max(1, binOf(end) - b0 + 1);
  const values = new Array(nb).fill(0);
  const ok = catMask(cats);
  const a = lowerBound(h.t, from), b = lowerBound(h.t, to);
  for (let i = a; i < b; i++) {
    if (!ok[h.c[i]] || !inB(h.lat[i], h.lon[i])) continue;
    const k = binOf(h.t[i]) - b0;
    if (k >= 0 && k < nb) values[k]++;
  }
  const starts = values.map((_, k) => unit === 'month'
    ? Date.UTC(Math.floor((b0 + k) / 12), (b0 + k) % 12, 1) / 60000
    : (b0 + k) * step);
  return { unit, values, starts, span };
}

export interface FeedItem { kind: Kind; d: Detail; t: number }

export function feedItems(store: Store, layers: Record<Kind, boolean>, from: number, to: number, cats: Set<CatKey>, inB: InBounds): FeedItem[] {
  const out: FeedItem[] = [];
  for (const k of KINDS) {
    if (!layers[k]) continue;
    for (const d of store.details[k].values()) {
      const t = isoMin(d.r);
      if (t < from || t >= to) continue;
      if (k === 'obs') {
        const tx = d.tx ? store.taxa.get(d.tx) : undefined;
        if (!cats.has(tx ? tx.cat : 'unid')) continue;
      }
      if (!inB(d.la, d.lo)) continue;
      out.push({ kind: k, d, t });
    }
  }
  return out.sort((a, b) => b.t - a.t);
}
