# Mosquito Alert live map

A fast, static, unofficial viewer for [Mosquito Alert](https://www.mosquitoalert.com/) citizen-science reports (mosquitoes, bites, breeding sites). It uses the public API at <https://api.mosquitoalert.com/v1/>.

Compared with the official map, it:

- **Shows reports minutes after they're sent.** A scheduled GitHub Action syncs every 15 min. Fresh reports (< 48 h) get a ring and a `NEW` badge.
- **Shows AI identifications right away.** These usually arrive about 10 min after a report is received. Each one is labelled `AI` or `Expert` with its confidence ("Confirmed 97%", "Probable"), so you don't have to wait weeks for expert validation.
- **Is fast.** The full history (165k mosquito reports since 2014) is about 1 MB gzipped and draws with WebGL (MapLibre). Filters apply instantly in the browser with no server round-trips.
- **Has a "Latest reports" feed** with photo thumbnails, place names and time-ago. It can be limited to the current map view, and clicking an item flies to the report.
- **Includes:** time presets (24 h … all time) plus a custom range, mosquito-type filters with live counts, a per-hour/day/week/month activity chart, a heatmap mode, bites and breeding-site layers, dark mode, geolocation, and shareable URLs (all state is in `#hash`).

## Why snapshots instead of calling the API from the browser?

The API only sends CORS headers for `*.mosquitoalert.com` origins, so a page hosted anywhere else can't call it directly. Instead, `fetch.py` runs in GitHub Actions and writes compact static JSON files:

| file | contents | size (gzip) |
|---|---|---|
| `data/meta.json` | sync time, counts, taxonomy → category mapping | 2 KB |
| `data/recent.json` | full details for the last 30 days (photos, place, AI/expert result, notes) | ~0.5 MB |
| `data/hist-obs.json` | every mosquito report: lat/lon (4 dp), received minute (delta-encoded), taxon | ~1.1 MB |
| `data/hist-bites.json`, `hist-sites.json` | same for bites / breeding sites (loaded only when the layer is switched on) | 0.8 / 0.14 MB |
| `data/ids/<kind>-<year>.json` | uuids aligned with history order, fetched lazily when you click an old point (for the "Full record" API link) | per year |

The sync keeps load on the API low:

- **Full refresh, once a day:** the three `/geo/` endpoints (~1 min total). This also picks up deletions.
- **Incremental, every 15 min:** list endpoints with `updated_at_after=<last sync − 15 min>`. That's usually one request per kind, taking about 8 s.
- **Saved state:** sync state (≈11 MB gz) is carried between runs in the Actions cache. If the cache is missing, the next run does a full bootstrap (~2 min).

## Setup (GitHub Pages)

1. Merge to `main`.
2. Go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Go to **Actions → "Mosquito Alert live map" → Run workflow**, or wait for the next 15-min tick.
   The site is served at `https://<user>.github.io/<repo>/mosquito-alert/`.

Notes:

- GitHub can start scheduled runs a few minutes late. It also disables `schedule` triggers in repos with no activity for 60 days; re-enable the workflow in the Actions tab if that happens.
- Photo thumbnails go through the free [images.weserv.nl](https://images.weserv.nl/) resizer (~2 KB instead of ~800 KB per photo), and fall back to the original image if it fails.

## Local development

```sh
python3 fetch.py --state /tmp/ma-state.json.gz --out site/data   # first run ~2 min, then ~8 s
cd site && python3 -m http.server 8000                              # open http://localhost:8000
```

`site/data/` is git-ignored. `fetch.py` uses only the Python stdlib.

## Categories

| colour | category | taxa |
|---|---|---|
| blue | Tiger mosquito | *Aedes albopictus*, *Ae. albopictus/cretinus* |
| orange | Yellow fever mosquito | *Aedes aegypti* |
| aqua | Asian bush / Korean | *Ae. japonicus*, *Ae. koreicus*, *Ae. japonicus/koreicus* |
| yellow | Common mosquito | *Culex* (genus and species) |
| pink | Other mosquitoes | other Culicidae (*Anopheles*, *Culiseta*, other *Aedes*, …) |
| grey | Not a mosquito | Insecta / Diptera / Chironomidae / Coleoptera … |
| light grey | Unidentified | no identification result (often no usable photo) |

Bites are violet dots. Breeding sites are green rings.
