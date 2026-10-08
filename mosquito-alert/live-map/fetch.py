#!/usr/bin/env python3
"""Snapshot the public Mosquito Alert API into compact static files.

The API (https://api.mosquitoalert.com/v1/) only sends CORS headers for
mosquitoalert.com origins, so a static site cannot query it from the browser.
This script runs on a schedule (GitHub Actions) and writes small JSON files the
static map loads instead.

Sync strategy (polite to the API, fast enough to run every ~15 min):
  * Full refresh (all /geo/ endpoints, ~1 min) at most once per FULL_EVERY_H
    hours, or when there is no previous state. This also drops deleted reports.
  * Otherwise incremental: list endpoints filtered by updated_at_after=last_sync
    (minus an overlap), usually a single page per kind.
  * Full detail records (photos, place name, AI/expert confidence, ...) are kept
    for reports received in the last DETAIL_DAYS days.

State is kept in a gzipped JSON file between runs (actions/cache in CI).
Stdlib only.
"""

import argparse
import datetime as dt
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.mosquitoalert.com/v1"
PHOTO_PREFIX = "https://webserver.mosquitoalert.com/media/tigapics/"
DETAIL_DAYS = 30
FULL_EVERY_H = 24
OVERLAP_MIN = 15
PAGE_SIZE = 100  # API maximum
STATE_VERSION = 1

KINDS = {
    "obs": "observations",
    "bites": "bites",
    "sites": "breeding-sites",
}
SITE_TYPES = ["storm_drain", "basin", "bucket", "fountain", "small_container", "well", "other"]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def now_utc():
    return dt.datetime.now(dt.timezone.utc)


def parse_ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def iso(d):
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def tmin(s):
    """ISO timestamp -> integer minutes since epoch."""
    return int(parse_ts(s).timestamp() // 60)


def get_json(url, tries=5):
    url = url.replace("http://", "https://", 1)
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "User-Agent": "mosquito-alert-live-map (static snapshot; github.com/corneliusroemer/llm-reports)",
        },
    )
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return json.loads(body)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            if attempt == tries - 1:
                raise
            wait = 2 ** (attempt + 1)
            log(f"  retry {url} in {wait}s: {e}")
            time.sleep(wait)


def get_pages(path, params):
    params = dict(params, page_size=PAGE_SIZE)
    url = f"{API}/{path}/?{urllib.parse.urlencode(params)}"
    out = []
    while url:
        d = get_json(url)
        out.extend(d["results"])
        url = d.get("next")
    return out


# --- record shapes ---------------------------------------------------------
# rec: compact per-report tuple used for the map (all history)
#   obs:   [lat, lon, tmin, taxon_id|None]
#   bites: [lat, lon, tmin]
#   sites: [lat, lon, tmin, site_type_idx, has_water(0/1/2=unknown)]
# det: slim detail dict for recent reports (popups + "latest" feed)


def water(v):
    return 2 if v is None else int(bool(v))


def site_idx(s):
    return SITE_TYPES.index(s) if s in SITE_TYPES else SITE_TYPES.index("other")


def rec_from_geo(kind, g):
    p = g["point"]
    r = [round(p["latitude"], 4), round(p["longitude"], 4), tmin(g["received_at"])]
    if kind == "obs":
        r.append(g.get("identification_taxon_id"))
    elif kind == "sites":
        r += [site_idx(g.get("site_type")), water(g.get("has_water"))]
    return r


def obs_result(d):
    ident = d.get("identification") or {}
    return ident.get("result") or {}


def rec_from_detail(kind, d):
    p = d["location"]["point"]
    r = [round(p["latitude"], 4), round(p["longitude"], 4), tmin(d["received_at"])]
    if kind == "obs":
        r.append((obs_result(d).get("taxon") or {}).get("id"))
    elif kind == "sites":
        r += [site_idx(d.get("site_type")), water(d.get("has_water"))]
    return r


def photo_name(url):
    return url[len(PHOTO_PREFIX):] if url and url.startswith(PHOTO_PREFIX) else url


def slim(kind, d):
    loc = d["location"]
    s = {
        "u": d["uuid"],
        "s": d.get("short_id"),
        "r": d["received_at"][:19] + "Z",
        "c": (d.get("created_at_local") or "")[:16],
        "la": round(loc["point"]["latitude"], 5),
        "lo": round(loc["point"]["longitude"], 5),
        "pl": loc.get("display_name"),
        "cc": (loc.get("country") or {}).get("name_en"),
        "ls": loc.get("source"),
    }
    if d.get("note"):
        s["no"] = d["note"][:500]
    if kind in ("obs", "sites"):
        s["ph"] = [photo_name(p["url"]) for p in d.get("photos") or []]
    if kind == "obs":
        ident = d.get("identification") or {}
        res = ident.get("result") or {}
        s["tx"] = (res.get("taxon") or {}).get("id")
        s["src"] = res.get("source")
        s["cl"] = res.get("confidence_label")
        if res.get("confidence") is not None:
            s["cf"] = round(res["confidence"], 3)
        s["na"] = ident.get("num_annotations")
        if ident.get("public_note"):
            s["pn"] = ident["public_note"][:800]
        if (ident.get("photo") or {}).get("url"):
            s["ip"] = photo_name(ident["photo"]["url"])
        s["env"] = d.get("event_environment")
    elif kind == "bites":
        c = d.get("counts") or {}
        s["n"] = c.get("total")
        s["bp"] = {k: v for k, v in c.items() if k != "total" and v}
        s["env"] = d.get("event_environment")
        s["mo"] = d.get("event_moment")
    elif kind == "sites":
        s["st"] = d.get("site_type")
        for k, short in (("has_water", "w"), ("has_larvae", "lv"), ("has_near_mosquitoes", "nm"), ("in_public_area", "pa")):
            if d.get(k) is not None:
                s[short] = d[k]
    return s


# --- sync ------------------------------------------------------------------


def empty_state():
    return {"version": STATE_VERSION, "last_sync": None, "last_full": None,
            "kinds": {k: {"rec": {}, "det": {}} for k in KINDS}}


def load_state(path):
    if not path or not os.path.exists(path):
        return empty_state()
    try:
        with gzip.open(path, "rt") as f:
            st = json.load(f)
        if st.get("version") != STATE_VERSION:
            log("state version mismatch; starting fresh")
            return empty_state()
        return st
    except Exception as e:  # corrupt cache -> rebuild
        log(f"could not read state ({e}); starting fresh")
        return empty_state()


def save_state(st, path):
    tmp = path + ".tmp"
    with gzip.open(tmp, "wt", compresslevel=6) as f:
        json.dump(st, f, separators=(",", ":"))
    os.replace(tmp, path)


def full_refresh(st, start):
    cutoff = iso(start - dt.timedelta(days=DETAIL_DAYS))
    for kind, path in KINDS.items():
        t0 = time.time()
        geo = get_json(f"{API}/{path}/geo/")
        ks = st["kinds"][kind]
        ks["rec"] = {g["uuid"]: rec_from_geo(kind, g) for g in geo}
        ks["det"] = {u: d for u, d in ks["det"].items() if u in ks["rec"]}
        log(f"  {kind}: {len(geo)} geo records in {time.time() - t0:.1f}s")
        if not ks["det"]:
            t0 = time.time()
            for d in get_pages(path, {"received_at_after": cutoff, "order_by": "received_at"}):
                ks["det"][d["uuid"]] = slim(kind, d)
                ks["rec"][d["uuid"]] = rec_from_detail(kind, d)
            log(f"  {kind}: bootstrapped {len(ks['det'])} details in {time.time() - t0:.1f}s")
    st["last_full"] = iso(start)


def incremental(st):
    since = iso(parse_ts(st["last_sync"]) - dt.timedelta(minutes=OVERLAP_MIN))
    for kind, path in KINDS.items():
        t0 = time.time()
        ks = st["kinds"][kind]
        rows = get_pages(path, {"updated_at_after": since, "order_by": "received_at"})
        for d in rows:
            if d.get("published") is False:
                ks["rec"].pop(d["uuid"], None)
                ks["det"].pop(d["uuid"], None)
                continue
            ks["rec"][d["uuid"]] = rec_from_detail(kind, d)
            ks["det"][d["uuid"]] = slim(kind, d)
        log(f"  {kind}: {len(rows)} updated since {since} ({time.time() - t0:.1f}s)")


def prune_details(st, start):
    cutoff = start - dt.timedelta(days=DETAIL_DAYS)
    for ks in st["kinds"].values():
        ks["det"] = {u: d for u, d in ks["det"].items() if parse_ts(d["r"]) >= cutoff}


def sync(st, force_full=False):
    start = now_utc()
    need_full = (force_full or not st["last_sync"] or not st["last_full"]
                 or start - parse_ts(st["last_full"]) > dt.timedelta(hours=FULL_EVERY_H))
    if need_full:
        log("full refresh")
        full_refresh(st, start)
    else:
        log("incremental sync")
        incremental(st)
    prune_details(st, start)
    st["last_sync"] = iso(start)
    return need_full


# --- output ----------------------------------------------------------------

def taxa_info():
    tree = get_json(f"{API}/taxa/tree/")
    out = []

    def cat(node, ancestors):
        i = node["id"]
        if i in (112, 111):
            return "albo"
        if i == 113:
            return "aegypti"
        if i in (110, 114, 115):
            return "japkor"
        if i == 10 or 10 in ancestors:
            return "culex"
        if i == 7 or 7 in ancestors:
            return "othermosq"
        return "notmosq"

    def walk(node, ancestors):
        out.append({
            "id": node["id"], "name": node["name"], "common": node.get("common_name"),
            "rank": node["rank"], "it": node.get("italicize", False),
            "parent": ancestors[-1] if ancestors else None, "cat": cat(node, ancestors),
        })
        for ch in node.get("children") or []:
            walk(ch, ancestors + [node["id"]])

    for root in tree if isinstance(tree, list) else [tree]:
        walk(root, [])
    return out


def dump(obj, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)


def write_outputs(st, out, taxa, did_full):
    meta = {
        "generated_at": iso(now_utc()),
        "last_sync": st["last_sync"],
        "last_full": st["last_full"],
        "did_full": did_full,
        "detail_days": DETAIL_DAYS,
        "photo_prefix": PHOTO_PREFIX,
        "api": API,
        "site_types": SITE_TYPES,
        "taxa": taxa,
        "kinds": {},
    }
    recent = {}
    for kind, ks in st["kinds"].items():
        items = sorted(ks["rec"].items(), key=lambda kv: (kv[1][2], kv[0]))
        index = {u: i for i, (u, _) in enumerate(items)}
        recs = [r for _, r in items]
        h = {"n": len(recs), "t0": recs[0][2] if recs else 0}
        prev = h["t0"]
        dts = []
        for r in recs:
            dts.append(r[2] - prev)
            prev = r[2]
        h["dt"] = dts
        h["lat"] = [round(r[0] * 1e4) for r in recs]
        h["lon"] = [round(r[1] * 1e4) for r in recs]
        if kind == "obs":
            h["tx"] = [r[3] or 0 for r in recs]
        elif kind == "sites":
            h["st"] = [r[3] for r in recs]
            h["w"] = [r[4] for r in recs]
        dump(h, f"{out}/hist-{kind}.json")

        # uuids per year, aligned with the history order (loaded lazily by popups)
        years = {}
        for u, r in items:
            y = dt.datetime.fromtimestamp(r[2] * 60, dt.timezone.utc).year
            years.setdefault(y, []).append(u)
        for y, us in years.items():
            dump(us, f"{out}/ids/{kind}-{y}.json")

        dets = sorted(ks["det"].values(), key=lambda d: d["r"], reverse=True)
        for d in dets:
            d["i"] = index.get(d["u"])
        recent[kind] = [d for d in dets if d["i"] is not None]
        meta["kinds"][kind] = {
            "count": len(recs),
            "newest": items[-1][1][2] if items else None,
            "years": sorted(years),
        }
    dump(recent, f"{out}/recent.json")
    dump(meta, f"{out}/meta.json")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--state", default="state.json.gz", help="gzipped state file (read + written)")
    ap.add_argument("--out", required=True, help="directory to write data files into")
    ap.add_argument("--full", action="store_true", help="force a full refresh")
    a = ap.parse_args()

    t0 = time.time()
    st = load_state(a.state)
    did_full = sync(st, force_full=a.full)
    save_state(st, a.state)
    write_outputs(st, a.out, taxa_info(), did_full)
    counts = {k: len(v["rec"]) for k, v in st["kinds"].items()}
    log(f"done in {time.time() - t0:.1f}s: {counts}")


if __name__ == "__main__":
    main()
