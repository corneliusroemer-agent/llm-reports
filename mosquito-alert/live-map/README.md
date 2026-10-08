# Mosquito Alert live map

A fast, unofficial viewer for [Mosquito Alert](https://www.mosquitoalert.com/) citizen-science reports (mosquitoes, bites, breeding sites), built with React, Vite, TypeScript and MapLibre GL. It uses the public API at <https://api.mosquitoalert.com/v1/>.

Compared with the official map, it:

- **Shows reports minutes after they're sent.** The page loads a static snapshot, then fetches everything updated since that snapshot straight from the API through a CORS proxy, and keeps polling every 3 min while the tab is visible. Reports from the last 48 h get a ring and a `NEW` badge.
- **Shows AI identifications right away.** These usually arrive about 10 min after a report is received. Each one is labelled `AI` or `Expert` with its confidence ("Confirmed 97%", "Probable"), so you don't have to wait for expert validation.
- **Is fast.** The full history (165k mosquito reports since 2014) is about 1 MB gzipped and draws with WebGL. Filtering happens in the browser with no server round-trips. Bites and breeding sites load only when you switch those layers on.
- **Has a "Latest reports" feed** with photo thumbnails, place names and time-ago. It can be limited to the current map view, and clicking an item flies to the report.
- **Includes:** time presets (24 h … all time) plus a custom range, mosquito-type filters with live counts, an activity chart, a heatmap, dark mode, geolocation, and shareable URLs (all state is in `#hash`).
- **Shows details for any report.** Clicking an old point looks up its uuid lazily and fetches its details (photos, place, identification) through the proxy.

## How data flows

```
GitHub Actions (every 6 h)                      Browser
  fetch.py ──► dist/data/*.json  ──(Pages)──►  snapshot (instant, cached)
                                                   +
  api.mosquitoalert.com ──► CORS proxy ──────►  live: updated_at_after=<snapshot time>
```

The API only sends CORS headers for `*.mosquitoalert.com`, so browsers elsewhere need a proxy. Proxies are tried as follows (`src/lib/proxy.ts`):

1. `?proxy=<template>` in the page URL.
2. `VITE_CORS_PROXY` at build time (the repo variable `CORS_PROXY` in CI).
3. Public fallbacks: allorigins, codetabs, corsproxy.io and cors.eu.org.

The first time, all of them are raced and the fastest is remembered. If none respond, the page says "live updates unavailable" and keeps working from the snapshot. It retries every 10 min and reloads the snapshot when a newer one is published.

**Public CORS proxies are unreliable.** When I tested (Oct 2026), most were down, rate-limited, or required an API key (corsproxy.io). For dependable live updates, deploy the 40-line Cloudflare Worker in [`proxy/worker.js`](proxy/worker.js), which is free up to 100k requests/day and forwards only `GET api.mosquitoalert.com`. Then set the repo variable `CORS_PROXY` to `https://<name>.<account>.workers.dev/?url={url}`.

### Snapshot files (`fetch.py`, stdlib-only Python)

| file | contents | size (gzip) |
|---|---|---|
| `meta.json` | sync time, counts, taxonomy → category mapping | 2 KB |
| `recent.json` | full details for the last 30 days (photos, place, AI/expert result, notes) | ~0.5 MB |
| `hist-obs.json` | every mosquito report: lat/lon (4 dp), received minute (delta-encoded), taxon | ~1.1 MB |
| `hist-bites.json`, `hist-sites.json` | same for bites / breeding sites | 0.8 / 0.14 MB |
| `ids/<kind>-<year>.json` | uuids aligned with history order, fetched only when you click an old point | per year |

Each sync is incremental (`updated_at_after`), plus a full `/geo/` refresh once a day to drop deleted reports. State is carried between runs in the Actions cache. Without the cache, a run bootstraps from scratch in about 2 min.

## Setup (GitHub Pages)

1. Merge to `main`.
2. Go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Optional: deploy `proxy/worker.js` and add the repo variable `CORS_PROXY` under **Settings → Secrets and variables → Actions → Variables**.
4. Go to **Actions → "Mosquito Alert live map" → Run workflow**.
   The site is served at `https://<user>.github.io/<repo>/mosquito-alert/`.

GitHub disables `schedule` triggers in repos with no activity for 60 days. If that happens, re-enable the workflow in the Actions tab. Live updates in the browser keep the page current regardless, as long as a proxy works.

## Development

```sh
npm install
npm run fetch-data   # snapshot into public/data (first run ~2 min, then seconds)
npm run dev          # http://localhost:5173
npm run build        # typecheck + production build into dist/
```

Code map:

| path | what |
|---|---|
| `src/lib/store.ts` | snapshot decoding into time-sorted typed arrays, live merge, lazy uuid/detail lookup |
| `src/lib/proxy.ts` | CORS proxy selection |
| `src/lib/stats.ts` | counts, chart bins, feed filtering |
| `src/components/MapView.tsx` | MapLibre map, layers, popups |
| `fetch.py` | snapshot builder used in CI |

Photo thumbnails go through the free [images.weserv.nl](https://images.weserv.nl/) resizer (~2 KB instead of ~800 KB per photo), and fall back to the original image if it fails.

## Categories

| colour | category | taxa |
|---|---|---|
| blue | Tiger mosquito | *Aedes albopictus*, *Ae. albopictus/cretinus* |
| orange | Yellow fever mosquito | *Aedes aegypti* |
| aqua | Asian bush / Korean | *Ae. japonicus*, *Ae. koreicus*, *Ae. japonicus/koreicus* |
| yellow | Common mosquito | *Culex* |
| pink | Other mosquitoes | other Culicidae (*Anopheles*, *Culiseta*, other *Aedes*, …) |
| grey | Not a mosquito | Insecta / Diptera / Chironomidae / Coleoptera … |
| light grey | Unidentified | no identification result (often no usable photo) |

Bites are violet dots. Breeding sites are green rings.
