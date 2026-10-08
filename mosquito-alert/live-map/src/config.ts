export type Kind = 'obs' | 'bites' | 'sites';
export const KINDS: Kind[] = ['obs', 'bites', 'sites'];

export const API = 'https://api.mosquitoalert.com/v1';
export const API_PATH: Record<Kind, string> = { obs: 'observations', bites: 'bites', sites: 'breeding-sites' };
export const KIND_LABEL: Record<Kind, string> = { obs: 'Mosquito reports', bites: 'Bites', sites: 'Breeding sites' };

export const DAY = 1440; // minutes
export const FRESH_MIN = 2 * DAY; // "new" highlight window
export const LIVE_POLL_MS = 3 * 60 * 1000;
export const LIVE_RETRY_MS = 10 * 60 * 1000;
export const META_POLL_MS = 30 * 60 * 1000;
export const FEED_PAGE = 50;

export const CATS = [
  { k: 'albo', label: 'Tiger mosquito', sub: 'Ae. albopictus' },
  { k: 'aegypti', label: 'Yellow fever mosquito', sub: 'Ae. aegypti' },
  { k: 'japkor', label: 'Asian bush / Korean', sub: 'Ae. japonicus, koreicus' },
  { k: 'culex', label: 'Common mosquito', sub: 'Culex' },
  { k: 'othermosq', label: 'Other mosquitoes', sub: 'Anopheles, Culiseta, …' },
  { k: 'notmosq', label: 'Not a mosquito', sub: 'other insects' },
  { k: 'unid', label: 'Unidentified', sub: 'no usable photo' },
] as const;
export type CatKey = (typeof CATS)[number]['k'];
export const CAT_KEYS: CatKey[] = CATS.map(c => c.k);
export const CAT_IDX = Object.fromEntries(CATS.map((c, i) => [c.k, i])) as Record<CatKey, number>;

export const SITE_LABEL: Record<string, string> = {
  storm_drain: 'Storm drain', basin: 'Basin', bucket: 'Bucket', fountain: 'Fountain',
  small_container: 'Small container', well: 'Well', other: 'Other site',
};

export const RANGES = { '1d': 1, '3d': 3, '7d': 7, '30d': 30, '90d': 90, '1y': 365, all: null } as const;
export type RangeKey = keyof typeof RANGES;
export const RANGE_LABEL: Record<RangeKey, string> = { '1d': '24 h', '3d': '3 d', '7d': '7 d', '30d': '30 d', '90d': '90 d', '1y': '1 y', all: 'All' };

/**
 * CORS proxies used for live updates, tried in order until one works.
 * `{url}` is replaced by the URL-encoded target, `{raw}` by the raw target.
 * Public proxies come and go; for reliability deploy proxy/worker.js and set
 * VITE_CORS_PROXY (comma-separated templates) at build time. Viewers can also
 * override with `?proxy=<template>` in the page URL.
 */
export const DEFAULT_PROXIES = [
  'https://api.allorigins.win/raw?url={url}',
  'https://api.codetabs.com/v1/proxy?quest={url}',
  'https://corsproxy.io/?url={url}',
  'https://cors.eu.org/{raw}',
];
