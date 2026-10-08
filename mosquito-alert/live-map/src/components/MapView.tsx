import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource } from 'maplibre-gl';
// MapLibre 6 runs tile parsing in a module worker; let Vite bundle it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { CATS, CAT_IDX, FRESH_MIN, KINDS, type Kind } from '../config';
import type { Columns } from '../types';
import { lowerBound } from '../lib/format';
import type { Mode, MapView as View, UiState } from '../lib/hashState';
import type { Bounds } from '../lib/stats';
import { store } from '../lib/store';
import { PopupContent, type PopupItem } from './PopupContent';

export type Theme = 'light' | 'dark';

export interface MapHandle {
  focus(item: PopupItem): void;
}

interface Props {
  version: number;
  ui: UiState;
  window: [number, number];
  now: number;
  theme: Theme;
  initialView: View | null;
  onView(view: View, bounds: Bounds): void;
}

maplibregl.setWorkerUrl(workerUrl);

const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const basemap = (t: Theme) => `https://basemaps.cartocdn.com/gl/${t === 'dark' ? 'dark-matter' : 'positron'}-gl-style/style.json`;
const RADIUS = (base: number): ExpressionSpecification =>
  ['interpolate', ['linear'], ['zoom'], 2, base * 0.6, 6, base, 10, base * 1.6, 15, base * 2.6];
const fadeIn = (to: number): ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], 9, 0, 11.5, to];

function toGeoJSON(h: Columns | undefined): GeoJSON.FeatureCollection {
  if (!h) return { type: 'FeatureCollection', features: [] };
  const features: GeoJSON.Feature[] = new Array(h.n);
  for (let i = 0; i < h.n; i++) {
    features[i] = {
      type: 'Feature', id: i,
      geometry: { type: 'Point', coordinates: [h.lon[i], h.lat[i]] },
      properties: { t: h.t[i], c: h.c[i] },
    };
  }
  return { type: 'FeatureCollection', features };
}

function heatRamp(theme: Theme): ExpressionSpecification {
  const s = theme === 'dark'
    ? ['#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb']
    : ['#cde2fb', '#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'];
  return ['interpolate', ['linear'], ['heatmap-density'],
    0, theme === 'dark' ? 'rgba(16,66,129,0)' : 'rgba(205,226,251,0)',
    0.08, s[0], 0.25, s[1], 0.45, s[2], 0.65, s[3], 0.85, s[4], 1, s[5]];
}

export const MapView = forwardRef<MapHandle, Props>(function MapView(props, ref) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const seen = useRef<Partial<Record<Kind, { cols: Columns; rev: number }>>>({});
  const popup = useRef<{ p: maplibregl.Popup; root: Root } | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const openPopup = (items: PopupItem[], lngLat: [number, number]) => {
    const map = mapRef.current;
    if (!map) return;
    popup.current?.p.remove();
    const el = document.createElement('div');
    const root = createRoot(el);
    root.render(<PopupContent items={items} />);
    const p = new maplibregl.Popup({ maxWidth: '320px', offset: 10, focusAfterOpen: false })
      .setLngLat(lngLat).setDOMContent(el).addTo(map);
    p.on('close', () => setTimeout(() => root.unmount()));
    popup.current = { p, root };
  };

  useImperativeHandle(ref, () => ({
    focus(item) {
      const map = mapRef.current;
      if (!map) return;
      map.flyTo({ center: item.lngLat, zoom: Math.max(map.getZoom(), 12), speed: 1.6 });
      openPopup([item], item.lngLat);
    },
  }));

  // sync data sources with the store's columns
  const syncSources = () => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    for (const k of KINDS) {
      const cols = store.cols[k];
      const s = seen.current[k];
      if (cols && (s?.cols !== cols || s.rev !== cols.rev)) {
        (map.getSource(k) as GeoJSONSource | undefined)?.setData(toGeoJSON(cols));
        seen.current[k] = { cols, rev: cols.rev };
      }
    }
  };

  const applyFilters = () => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const { ui, window: [from, to], now } = latest.current;
    const time: ExpressionSpecification[] = [['>=', ['get', 't'], from], ['<', ['get', 't'], to]];
    const cats: ExpressionSpecification = ['in', ['get', 'c'], ['literal', [...ui.cats].map(k => CAT_IDX[k])]];
    const fresh: ExpressionSpecification = ['>=', ['get', 't'], Math.max(from, now - FRESH_MIN)];
    map.setFilter('obs', ['all', ...time, cats]);
    map.setFilter('obs-heat', ['all', ...time, cats]);
    map.setFilter('obs-fresh', ['all', ...time, cats, fresh]);
    map.setFilter('bites', ['all', ...time]);
    map.setFilter('sites', ['all', ...time]);
    const vis = (id: string, on: boolean) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    const heat = (ui.mode as Mode) === 'heat';
    const obs = store.cols.obs;
    if (heat && obs) {
      // scale intensity with the number of reports in range so "All time" doesn't saturate
      const n = Math.max(1, lowerBound(obs.t, to) - lowerBound(obs.t, from));
      const f = Math.min(1.5, Math.max(0.02, 20 / Math.sqrt(n)));
      map.setPaintProperty('obs-heat', 'heatmap-intensity', ['interpolate', ['linear'], ['zoom'], 2, 0.5 * f, 10, 2 * f]);
    }
    vis('obs', ui.layers.obs);
    vis('obs-fresh', ui.layers.obs);
    vis('obs-heat', ui.layers.obs && heat);
    vis('bites', ui.layers.bites);
    vis('sites', ui.layers.sites);
    map.setPaintProperty('obs', 'circle-opacity', heat ? fadeIn(0.88) : 0.88);
    map.setPaintProperty('obs', 'circle-stroke-opacity', heat ? fadeIn(1) : 1);
    map.setPaintProperty('obs-fresh', 'circle-opacity', heat ? fadeIn(1) : 1);
    map.setPaintProperty('obs-fresh', 'circle-stroke-opacity', heat ? fadeIn(1) : 1);
  };

  const addLayers = () => {
    const map = mapRef.current!;
    const theme = latest.current.theme;
    const surface = cssVar('--surface');
    const catColor: ExpressionSpecification = ['match', ['get', 'c'], ...CATS.flatMap((c, i) => [i, cssVar(`--c-${c.k}`)]), '#888'] as unknown as ExpressionSpecification;
    seen.current = {};
    for (const k of KINDS) {
      const cols = store.cols[k];
      map.addSource(k, { type: 'geojson', data: toGeoJSON(cols) });
      if (cols) seen.current[k] = { cols, rev: cols.rev };
    }
    map.addLayer({ id: 'sites', type: 'circle', source: 'sites', paint: {
      'circle-radius': RADIUS(3), 'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': cssVar('--c-sites'), 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 3, 1.2, 10, 2.2],
    } });
    map.addLayer({ id: 'bites', type: 'circle', source: 'bites', paint: {
      'circle-radius': RADIUS(3), 'circle-color': cssVar('--c-bites'), 'circle-opacity': 0.85,
      'circle-stroke-color': surface, 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 0.3, 9, 1],
    } });
    map.addLayer({ id: 'obs-heat', type: 'heatmap', source: 'obs', paint: {
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 2, 6, 8, 16, 12, 28],
      'heatmap-color': heatRamp(theme),
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.9, 13, 0],
    } });
    map.addLayer({ id: 'obs', type: 'circle', source: 'obs', layout: { 'circle-sort-key': ['get', 't'] }, paint: {
      'circle-radius': RADIUS(3.2), 'circle-color': catColor,
      'circle-stroke-color': surface, 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 0.3, 9, 1.2],
    } });
    // fresh reports get a ring and sit on top
    map.addLayer({ id: 'obs-fresh', type: 'circle', source: 'obs', paint: {
      'circle-radius': RADIUS(5), 'circle-color': catColor,
      'circle-stroke-color': cssVar('--text'), 'circle-stroke-width': 1.6,
    } });
    ready.current = true;
    applyFilters();
  };

  // create the map once
  useEffect(() => {
    const v = latest.current.initialView;
    const map = new maplibregl.Map({
      container: box.current!, style: basemap(latest.current.theme),
      center: v ? [v.lon, v.lat] : [5, 44], zoom: v?.zoom ?? 4.2,
      attributionControl: { compact: true }, maxPitch: 0, dragRotate: false,
    });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: false }, fitBoundsOptions: { maxZoom: 11 } }), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
    map.on('style.load', addLayers);
    const report = () => {
      const c = map.getCenter(), b = map.getBounds();
      latest.current.onView({ zoom: map.getZoom(), lat: c.lat, lon: c.lng }, { w: b.getWest(), e: b.getEast(), s: b.getSouth(), n: b.getNorth() });
    };
    map.on('moveend', report);
    map.once('load', report);
    for (const id of ['obs', 'obs-fresh', 'bites', 'sites']) {
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    }
    map.on('click', (e: maplibregl.MapMouseEvent) => {
      const pad = 7;
      const layers = ['obs-fresh', 'obs', 'bites', 'sites'].filter(id => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
      const feats = map.queryRenderedFeatures([[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]], { layers });
      const seen = new Set<string>();
      const items: PopupItem[] = [];
      for (const f of feats) {
        const kind = f.source as Kind;
        const i = f.id as number;
        if (seen.has(kind + i) || !store.cols[kind]) continue;
        seen.add(kind + i);
        items.push({ kind, i, t: f.properties.t as number, lngLat: [store.cols[kind]!.lon[i], store.cols[kind]!.lat[i]] });
      }
      if (!items.length) return;
      items.sort((a, b) => b.t - a.t);
      openPopup(items, items[0].lngLat);
    });
    return () => { ready.current = false; map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // theme switch: reload basemap, layers are re-added on style.load
  const firstTheme = useRef(props.theme);
  useEffect(() => {
    if (props.theme === firstTheme.current) return;
    firstTheme.current = props.theme;
    const map = mapRef.current;
    if (!map) return;
    ready.current = false;
    map.setStyle(basemap(props.theme), { diff: false });
  }, [props.theme]);

  useEffect(syncSources, [props.version]);
  useEffect(applyFilters, [props.ui, props.window[0], props.window[1], props.now, props.version]);

  return <main ref={box} className="absolute inset-0" aria-label="Map" />;
});
