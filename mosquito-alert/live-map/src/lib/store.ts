/**
 * Data store: static snapshot (written by fetch.py every ~6 h) + live updates
 * fetched in the browser through a CORS proxy.
 *
 * Columns are kept sorted by received time so time windows are binary searches.
 * Feature ids on the map are row indices; they change when live rows are
 * inserted, which bumps `rev` so the map re-uploads the source.
 */
import { API, API_PATH, CAT_IDX, DAY, KINDS, type Kind } from '../config';
import type { ApiRecord, Columns, Detail, Meta, Page, RawHist, Recent, Taxon } from '../types';
import { isoMin, lowerBound, minIso, nowMin } from './format';
import { apiGet, proxyHost } from './proxy';
import { slim } from './slim';

const DATA = `${import.meta.env.BASE_URL}data/`;
const LIVE_OVERLAP_MIN = 15;
const LIVE_MAX_PAGES = 40;

export type LiveStatus = 'off' | 'connecting' | 'ok' | 'failed';

export interface LiveState {
  status: LiveStatus;
  at?: number; // minute of last successful poll
  proxy?: string | null;
  added: number; // new reports merged since the snapshot
  error?: string;
}

async function getJSON<T>(path: string, version?: string | true): Promise<T> {
  const v = version === true ? String(Date.now()) : version;
  const r = await fetch(DATA + path + (v ? `?v=${encodeURIComponent(v)}` : ''), version === true ? { cache: 'no-store' } : {});
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

const emptyByKind = <T>(f: () => T) => Object.fromEntries(KINDS.map(k => [k, f()])) as Record<Kind, T>;

export class Store {
  meta: Meta | null = null;
  taxa = new Map<number, Taxon>();
  cols: Partial<Record<Kind, Columns>> = {};
  details = emptyByKind(() => new Map<string, Detail>());
  live: LiveState = { status: 'off', added: 0 };
  error: string | null = null;

  private snapT: Partial<Record<Kind, Int32Array>> = {};
  private index = emptyByKind(() => new Map<string, number>());
  private recent: Recent | null = null;
  private loads: Partial<Record<Kind, Promise<void>>> = {};
  private ids = new Map<string, Promise<string[]>>();
  private liveSince: Partial<Record<Kind, number>> = {};
  private polling = false;

  // --- subscription (useSyncExternalStore) ---
  version = 0;
  private listeners = new Set<() => void>();
  subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  getVersion = () => this.version;
  private notify() { this.version++; this.listeners.forEach(f => f()); }

  catOf(tx: number | null | undefined): number {
    const t = tx ? this.taxa.get(tx) : undefined;
    return t ? CAT_IDX[t.cat] : CAT_IDX.unid;
  }

  // --- snapshot ---
  async init() {
    try {
      this.meta = await getJSON<Meta>('meta.json', true);
      this.taxa = new Map(this.meta.taxa.map(t => [t.id, t]));
      this.recent = await getJSON<Recent>('recent.json', this.meta.generated_at);
      for (const k of KINDS) for (const d of this.recent[k]) this.details[k].set(d.u, d);
      this.notify();
    } catch (e) {
      this.error = (e as Error).message;
      this.notify();
      throw e;
    }
  }

  /** Re-load the snapshot if a newer one was published (used when live updates fail). */
  async checkSnapshot() {
    if (!this.meta) return;
    const m = await getJSON<Meta>('meta.json', true);
    if (m.generated_at === this.meta.generated_at) return;
    const loaded = KINDS.filter(k => this.cols[k]);
    this.cols = {};
    this.snapT = {};
    this.loads = {};
    this.ids.clear();
    this.index = emptyByKind(() => new Map());
    this.details = emptyByKind(() => new Map());
    this.liveSince = {};
    this.live = { ...this.live, added: 0 };
    await this.init();
    await Promise.all(loaded.map(k => this.loadKind(k)));
  }

  loadKind(kind: Kind): Promise<void> {
    if (!this.meta) return Promise.resolve();
    this.loads[kind] ||= getJSON<RawHist>(`hist-${kind}.json`, this.meta.generated_at)
      .then(raw => {
        this.decode(kind, raw);
        this.notify();
      })
      .catch(e => {
        delete this.loads[kind];
        this.error = (e as Error).message;
        this.notify();
      });
    return this.loads[kind]!;
  }

  private decode(kind: Kind, h: RawHist) {
    const n = h.n;
    const cols: Columns = {
      n,
      t: new Int32Array(n), lat: new Float32Array(n), lon: new Float32Array(n),
      c: new Uint8Array(n), tx: new Uint16Array(n), st: new Uint8Array(n), w: new Uint8Array(n),
      uuid: new Array(n), snap: new Int32Array(n), rev: 0,
    };
    let acc = h.t0;
    for (let i = 0; i < n; i++) {
      acc += h.dt[i];
      cols.t[i] = acc;
      cols.lat[i] = h.lat[i] / 1e4;
      cols.lon[i] = h.lon[i] / 1e4;
      cols.snap[i] = i;
    }
    if (h.tx) for (let i = 0; i < n; i++) { cols.tx[i] = h.tx[i]; cols.c[i] = this.catOf(h.tx[i]); }
    if (h.st) cols.st.set(h.st);
    if (h.w) cols.w.set(h.w);
    for (const d of this.recent?.[kind] || []) {
      if (d.i != null && d.i < n) { cols.uuid[d.i] = d.u; this.index[kind].set(d.u, d.i); }
    }
    this.snapT[kind] = cols.t.slice();
    this.cols[kind] = cols;
  }

  // --- live updates ---
  async pollLive(): Promise<void> {
    if (!this.meta || this.polling) return;
    this.polling = true;
    const start = nowMin();
    if (this.live.status !== 'ok') { this.live = { ...this.live, status: 'connecting' }; this.notify(); }
    try {
      // only kinds whose history is loaded can be merged
      const kinds = KINDS.filter(k => this.cols[k]);
      const results = await Promise.all(kinds.map(k => this.fetchUpdates(k)));
      let added = 0;
      kinds.forEach((k, j) => {
        added += this.merge(k, results[j]);
        this.liveSince[k] = start - 2;
      });
      this.live = { status: 'ok', at: start, proxy: proxyHost(), added: this.live.added + added };
    } catch (e) {
      this.live = { ...this.live, status: 'failed', error: (e as Error).message };
    } finally {
      this.polling = false;
      this.notify();
    }
  }

  private async fetchUpdates(kind: Kind): Promise<ApiRecord[]> {
    const since = this.liveSince[kind] ?? isoMin(this.meta!.last_sync) - LIVE_OVERLAP_MIN;
    const q = new URLSearchParams({ updated_at_after: minIso(since), order_by: 'received_at', page_size: '100' });
    let url: string | null = `${API}/${API_PATH[kind]}/?${q}`;
    const out: ApiRecord[] = [];
    for (let p = 0; url && p < LIVE_MAX_PAGES; p++) {
      const page: Page<ApiRecord> = await apiGet<Page<ApiRecord>>(url, j => !!j && Array.isArray((j as Page<ApiRecord>).results));
      out.push(...page.results);
      url = page.next;
    }
    return out;
  }

  /** Merge live API records into the columns. Returns number of new rows. */
  private merge(kind: Kind, rows: ApiRecord[]): number {
    const cols = this.cols[kind];
    if (!cols || !this.meta || !rows.length) return 0;
    // Anything received after this cutoff that isn't indexed yet can't be in the
    // snapshot (recent.json indexes every snapshot row in the detail window).
    const cutoff = isoMin(this.meta.last_sync) - this.meta.detail_days * DAY + 60;
    const siteTypes = this.meta.site_types;
    type Row = { u: string; t: number; lat: number; lon: number; tx: number; c: number; st: number; w: number };
    const pending: Row[] = [];
    let touched = false;
    for (const r of rows) {
      if (r.published === false) continue;
      const d = slim(kind, r, this.meta.photo_prefix);
      this.details[kind].set(d.u, d);
      const tx = d.tx ?? 0;
      const st = Math.max(0, siteTypes.indexOf(d.st || 'other'));
      const row: Row = {
        u: d.u, t: isoMin(r.received_at), lat: r.location.point.latitude, lon: r.location.point.longitude,
        tx, c: kind === 'obs' ? this.catOf(tx) : 0, st, w: d.w == null ? 2 : +d.w,
      };
      const i = this.index[kind].get(d.u);
      if (i != null) {
        cols.lat[i] = row.lat; cols.lon[i] = row.lon; cols.tx[i] = row.tx; cols.c[i] = row.c;
        cols.st[i] = row.st; cols.w[i] = row.w;
        touched = true;
      } else if (row.t >= cutoff) {
        pending.push(row);
      }
    }
    if (pending.length) {
      pending.sort((a, b) => a.t - b.t);
      const n = cols.n + pending.length;
      const nc: Columns = {
        n, t: new Int32Array(n), lat: new Float32Array(n), lon: new Float32Array(n),
        c: new Uint8Array(n), tx: new Uint16Array(n), st: new Uint8Array(n), w: new Uint8Array(n),
        uuid: new Array(n), snap: new Int32Array(n), rev: cols.rev + 1,
      };
      // linear merge of two time-sorted sequences
      let a = 0, b = 0;
      for (let o = 0; o < n; o++) {
        if (b >= pending.length || (a < cols.n && cols.t[a] <= pending[b].t)) {
          nc.t[o] = cols.t[a]; nc.lat[o] = cols.lat[a]; nc.lon[o] = cols.lon[a]; nc.c[o] = cols.c[a];
          nc.tx[o] = cols.tx[a]; nc.st[o] = cols.st[a]; nc.w[o] = cols.w[a]; nc.uuid[o] = cols.uuid[a]; nc.snap[o] = cols.snap[a];
          a++;
        } else {
          const p = pending[b++];
          nc.t[o] = p.t; nc.lat[o] = p.lat; nc.lon[o] = p.lon; nc.c[o] = p.c;
          nc.tx[o] = p.tx; nc.st[o] = p.st; nc.w[o] = p.w; nc.uuid[o] = p.u; nc.snap[o] = -1;
        }
      }
      const idx = new Map<string, number>();
      nc.uuid.forEach((u, i) => { if (u) idx.set(u, i); });
      this.index[kind] = idx;
      this.cols[kind] = nc;
    } else if (touched) {
      cols.rev++;
    }
    return pending.length;
  }

  // --- per-report lookups ---
  indexOf(kind: Kind, uuid: string): number | undefined {
    return this.index[kind].get(uuid);
  }

  /** uuid of row i; older rows resolve lazily via per-year id files. */
  async uuidAt(kind: Kind, i: number): Promise<string | undefined> {
    const cols = this.cols[kind];
    if (!cols || !this.meta) return undefined;
    if (cols.uuid[i]) return cols.uuid[i];
    const s = cols.snap[i];
    const snapT = this.snapT[kind];
    if (s < 0 || !snapT) return undefined;
    const year = new Date(snapT[s] * 60000).getUTCFullYear();
    const key = `${kind}-${year}`;
    if (!this.ids.has(key)) this.ids.set(key, getJSON<string[]>(`ids/${key}.json`, this.meta.generated_at));
    try {
      const ids = await this.ids.get(key)!;
      const u = ids[s - lowerBound(snapT, Date.UTC(year, 0, 1) / 60000)];
      const cur = this.cols[kind];
      if (u && cur === cols) { cols.uuid[i] = u; this.index[kind].set(u, i); }
      return u;
    } catch {
      this.ids.delete(key);
      return undefined;
    }
  }

  /** Details for row i: cached (snapshot/live) or fetched through the proxy. */
  async detailAt(kind: Kind, i: number): Promise<Detail | undefined> {
    const u = await this.uuidAt(kind, i);
    if (!u) return undefined;
    const have = this.details[kind].get(u);
    if (have) return have;
    if (!this.meta) return undefined;
    try {
      const r = await apiGet<ApiRecord>(`${API}/${API_PATH[kind]}/${u}/`, j => !!j && (j as ApiRecord).uuid === u);
      const d = slim(kind, r, this.meta.photo_prefix);
      this.details[kind].set(u, d);
      return d;
    } catch {
      return undefined;
    }
  }

  recordUrl(kind: Kind, uuid: string) {
    return `${API}/${API_PATH[kind]}/${uuid}/`;
  }
}

export const store = new Store();
// debugging handle: inspect state from the browser console
(window as unknown as { maStore: Store }).maStore = store;
