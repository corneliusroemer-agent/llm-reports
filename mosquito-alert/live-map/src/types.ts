import type { CatKey, Kind } from './config';

export interface Taxon {
  id: number;
  name: string;
  common: string | null;
  rank: string;
  it: boolean;
  parent: number | null;
  cat: CatKey;
}

export interface Meta {
  generated_at: string;
  last_sync: string;
  last_full: string;
  detail_days: number;
  photo_prefix: string;
  api: string;
  site_types: string[];
  taxa: Taxon[];
  kinds: Record<Kind, { count: number; newest: number | null; years: number[] }>;
}

/** Slim report details (see fetch.py `slim`). */
export interface Detail {
  u: string;
  s?: string | null;
  r: string; // received_at ISO
  c?: string; // created_at_local
  la: number;
  lo: number;
  pl?: string | null;
  cc?: string | null;
  ls?: string | null;
  no?: string;
  ph?: string[];
  // obs
  tx?: number | null;
  src?: string | null;
  cl?: string | null;
  cf?: number;
  na?: number | null;
  pn?: string;
  ip?: string;
  env?: string | null;
  // bites
  n?: number | null;
  bp?: Record<string, number>;
  mo?: string | null;
  // sites
  st?: string | null;
  w?: boolean;
  lv?: boolean;
  nm?: boolean;
  pa?: boolean;
  i?: number; // index into snapshot history (recent.json only)
}

export type Recent = Record<Kind, Detail[]>;

export interface RawHist {
  n: number;
  t0: number;
  dt: number[];
  lat: number[];
  lon: number[];
  tx?: number[];
  st?: number[];
  w?: number[];
}

/** Columnar, time-sorted report arrays for one kind. */
export interface Columns {
  n: number;
  t: Int32Array; // received, minutes since epoch
  lat: Float32Array;
  lon: Float32Array;
  c: Uint8Array; // category index (obs)
  tx: Uint16Array; // taxon id (obs), 0 = none
  st: Uint8Array; // site type index (sites)
  w: Uint8Array; // has water 0/1/2=unknown (sites)
  uuid: (string | undefined)[]; // known uuids (recent, live, or lazily resolved)
  snap: Int32Array; // index in the snapshot history, -1 for live-only rows
  rev: number; // bumped on every mutation
}

/** Minimal shape of an API list/detail record. */
export interface ApiRecord {
  uuid: string;
  short_id?: string | null;
  received_at: string;
  created_at_local?: string | null;
  published?: boolean;
  note?: string | null;
  location: {
    source?: string | null;
    point: { latitude: number; longitude: number };
    display_name?: string | null;
    country?: { name_en?: string | null } | null;
  };
  photos?: { uuid: string; url: string }[];
  identification?: {
    photo?: { url?: string } | null;
    num_annotations?: number | null;
    public_note?: string | null;
    result?: {
      source?: string | null;
      taxon?: { id: number } | null;
      confidence?: number | null;
      confidence_label?: string | null;
    } | null;
  } | null;
  event_environment?: string | null;
  event_moment?: string | null;
  counts?: Record<string, number> | null;
  site_type?: string | null;
  has_water?: boolean | null;
  has_larvae?: boolean | null;
  has_near_mosquitoes?: boolean | null;
  in_public_area?: boolean | null;
}

export interface Page<T> {
  count: number;
  next: string | null;
  results: T[];
}
