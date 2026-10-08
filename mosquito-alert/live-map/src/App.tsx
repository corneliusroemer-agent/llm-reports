import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DAY, FEED_PAGE, KINDS, LIVE_POLL_MS, LIVE_RETRY_MS, META_POLL_MS, type Kind } from './config';
import { ActivityChart } from './components/ActivityChart';
import { Categories, Layers, TimeRange } from './components/Controls';
import { Feed } from './components/Feed';
import { MapView, type MapHandle, type Theme } from './components/MapView';
import { ago, fmtN, isoMin, nowMin } from './lib/format';
import { buildHash, parseHash, timeWindow, type MapView as View, type UiState } from './lib/hashState';
import { binObs, countAll, feedItems, inBoundsFn, type Bounds, type FeedItem } from './lib/stats';
import { store } from './lib/store';

const THEME_KEY = 'ma-theme';

function systemTheme(): Theme {
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function storedTheme(): Theme | null {
  try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : null; } catch { return null; }
}
/** Applied synchronously (before React effects) so the map reads the right CSS colours. */
function applyTheme(pref: Theme | null) {
  if (pref) document.documentElement.dataset.theme = pref;
  else delete document.documentElement.dataset.theme;
}
applyTheme(storedTheme());

function useNow(ms = 30000) {
  const [now, setNow] = useState(nowMin);
  useEffect(() => { const id = setInterval(() => setNow(nowMin()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

const initial = parseHash(location.hash);

export default function App() {
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const [ui, setUi] = useState<UiState>(initial.ui);
  const [view, setView] = useState<View | null>(initial.view);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [feedLimit, setFeedLimit] = useState(FEED_PAGE);
  const [themePref, setThemePref] = useState<Theme | null>(storedTheme);
  const [sysTheme, setSysTheme] = useState<Theme>(systemTheme);
  const theme = themePref ?? sysTheme;
  const now = useNow();
  const mapRef = useRef<MapHandle>(null);

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const f = () => setSysTheme(systemTheme());
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);

  // boot: snapshot first, then live polling through the CORS proxy
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let lastMeta = Date.now();
    const loop = async () => {
      if (stopped) return;
      if (!document.hidden) {
        await store.pollLive();
        if (store.live.status === 'failed' && Date.now() - lastMeta > META_POLL_MS) {
          lastMeta = Date.now();
          await store.checkSnapshot().catch(() => {});
        }
      }
      timer = setTimeout(loop, store.live.status === 'ok' ? LIVE_POLL_MS : LIVE_RETRY_MS);
    };
    const onVis = () => { if (!document.hidden) { clearTimeout(timer); loop(); } };
    store.init().then(() => {
      const loads = KINDS.filter(k => initial.ui.layers[k]).map(k => store.loadKind(k));
      return Promise.all(loads);
    }).then(loop).catch(() => {});
    document.addEventListener('visibilitychange', onVis);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  // lazily load layers when switched on, then pull their live updates
  useEffect(() => {
    if (!store.meta) return;
    for (const k of KINDS) {
      if (ui.layers[k] && !store.cols[k]) store.loadKind(k).then(() => { if (store.live.status === 'ok') store.pollLive(); });
    }
  }, [ui.layers, version]);

  // URL hash
  useEffect(() => {
    const t = setTimeout(() => history.replaceState(null, '', buildHash(ui, view, now)), 250);
    return () => clearTimeout(t);
  }, [ui, view, now]);
  useEffect(() => setFeedLimit(FEED_PAGE), [ui]);

  const win = useMemo(() => timeWindow(ui, now), [ui, now]);
  const inB = useMemo(() => inBoundsFn(ui.inView ? bounds : null), [ui.inView, bounds]);
  const counts = useMemo(() => countAll(store.cols, win[0], win[1], ui.cats, inB),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, win[0], win[1], ui.cats, inB]);
  const bins = useMemo(() => binObs(store.cols.obs, win[0], win[1], now, ui.cats, inB),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, win[0], win[1], ui.cats, inB, now]);
  const feed = useMemo(() => (store.meta ? feedItems(store, ui.layers, win[0], win[1], ui.cats, inB) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, win[0], win[1], ui.cats, ui.layers, inB]);

  const onView = useCallback((v: View, b: Bounds) => { setView(v); setBounds(b); }, []);
  const onPick = useCallback((it: FeedItem) => {
    const i = store.indexOf(it.kind, it.d.u);
    mapRef.current?.focus({ kind: it.kind, i, t: it.t, lngLat: [it.d.lo, it.d.la], detail: it.d });
  }, []);
  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
    setThemePref(next);
  };
  // keep the attribute in sync if the OS theme changes while following it
  if (!themePref) applyTheme(null);

  const meta = store.meta;
  const loaded = Object.fromEntries(KINDS.map(k => [k, !!store.cols[k]])) as Record<Kind, boolean>;
  const detailDays = meta?.detail_days ?? 30;
  const notes: string[] = [];
  if (meta && !feed.length) notes.push(Object.values(ui.layers).some(Boolean) ? 'No reports match the current filters in this area.' : 'Turn on a layer to see reports.');
  if (win[0] < now - detailDays * DAY) notes.push(`The feed covers the last ${detailDays} days; older reports are on the map (click a dot).`);
  const scope = `${ui.range === 'all' ? 'all time' : 'in range'}, ${ui.inView ? 'in view' : 'total'}`;

  return (
    <div className="app">
      <aside className="panel">
        <Header now={now} onTheme={toggleTheme} />
        <TimeRange ui={ui} setUi={setUi} window={win} now={now} firstT={store.cols.obs ? store.cols.obs.t[0] : null} />
        <Layers ui={ui} setUi={setUi} counts={counts} loaded={loaded} />
        <Categories ui={ui} setUi={setUi} counts={counts} scope={scope} loaded={loaded.obs} />
        <section>
          <div className="h2-row">
            <h2>{bins ? `Mosquito reports per ${bins.unit} · ${fmtN(bins.values.reduce((a, b) => a + b, 0))}` : 'Mosquito reports'}</h2>
            <label className="mini"><input type="checkbox" checked={ui.inView} onChange={e => { const v = e.target.checked; setUi(u => ({ ...u, inView: v })); }} /> only in map view</label>
          </div>
          <ActivityChart bins={bins} />
        </section>
        <Feed items={feed} limit={feedLimit} onMore={() => setFeedLimit(l => l + FEED_PAGE)} onPick={onPick}
          now={now} inView={ui.inView} note={notes.join(' ')} />
        <footer className="foot">
          <p>Unofficial viewer. Data © <a href="https://www.mosquitoalert.com/" target="_blank" rel="noopener">Mosquito Alert</a> participants,
            via the public <a href="https://api.mosquitoalert.com/v1/" target="_blank" rel="noopener">API</a>.
            Identifications marked <b>AI</b> are automatic and not yet expert-validated.</p>
        </footer>
      </aside>
      <div className="map-wrap">
        <MapView ref={mapRef} version={version} ui={ui} window={win} now={now} theme={theme} initialView={initial.view} onView={onView} />
        {KINDS.some(k => ui.layers[k] && !loaded[k]) && !store.error && <div className="loading">Loading reports…</div>}
      </div>
    </div>
  );
}

function Header({ now, onTheme }: { now: number; onTheme(): void }) {
  const meta = store.meta;
  const live = store.live;
  let text = 'Loading data…', cls = '';
  if (store.error) { text = `Could not load data: ${store.error}`; cls = 'bad'; }
  else if (meta) {
    const snap = isoMin(meta.generated_at);
    const newest = Math.max(
      ...KINDS.map(k => meta.kinds[k].newest || 0),
      ...KINDS.map(k => { const c = store.cols[k]; return c && c.n ? c.t[c.n - 1] : 0; }),
    );
    if (live.status === 'ok') {
      cls = 'ok';
      text = `Live · checked ${ago(live.at!, now)} · newest report ${ago(newest, now)}`;
    } else if (live.status === 'connecting') {
      text = `Snapshot from ${ago(snap, now)} · connecting for live updates…`;
    } else {
      cls = live.status === 'failed' ? 'warn' : '';
      text = `Snapshot from ${ago(snap, now)} · newest report ${ago(newest, now)}${live.status === 'failed' ? ' · live updates unavailable' : ''}`;
    }
  }
  const title = meta
    ? `Snapshot ${meta.generated_at} (rebuilt every 6 h).` + (live.status === 'ok'
      ? ` Live updates every 3 min via ${live.proxy}; ${live.added} new reports since the snapshot.`
      : live.error ? ` Live updates failed: ${live.error}` : '')
    : '';
  return (
    <header className="head">
      <div className="title-row">
        <h1>Mosquito Alert <span>live map</span></h1>
        <button className="icon-btn" onClick={onTheme} title="Toggle light/dark" aria-label="Toggle light/dark theme">◐</button>
      </div>
      <p className={`fresh ${cls}`} title={title}><span className="dot" />{text}</p>
    </header>
  );
}
