import { DAY } from '../config';

export const nowMin = () => Math.floor(Date.now() / 60000);
export const isoMin = (s: string) => Math.floor(Date.parse(s) / 60000);
export const minIso = (m: number) => new Date(m * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
export const fmtN = (n: number) => n.toLocaleString('en-US');
export const fmtDate = (min: number) => new Date(min * 60000).toISOString().slice(0, 10);
export const fmtDateTime = (min: number) =>
  new Date(min * 60000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function ago(min: number, now = nowMin()): string {
  const d = now - min;
  if (d < 1) return 'just now';
  if (d < 60) return `${d} min ago`;
  if (d < DAY) return `${Math.floor(d / 60)} h ago`;
  if (d < 30 * DAY) return `${Math.floor(d / DAY)} d ago`;
  return fmtDate(min);
}

export function lowerBound(arr: ArrayLike<number>, v: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

export function photoUrl(prefix: string, name: string) {
  return /^https?:/.test(name) ? name : prefix + name;
}

/** Resized thumbnail via images.weserv.nl (falls back to the original on error). */
export function thumbUrl(full: string, w: number, h: number) {
  const u = full.replace(/^https?:\/\//, '');
  return `https://images.weserv.nl/?url=${encodeURIComponent(u)}&w=${w}&h=${h}&fit=cover&output=webp`;
}
