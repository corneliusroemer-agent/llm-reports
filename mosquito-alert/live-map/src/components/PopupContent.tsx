import { useEffect, useState } from 'react';
import { DAY, FRESH_MIN, SITE_LABEL, type Kind } from '../config';
import type { Detail } from '../types';
import { ago, fmtDateTime, isoMin, nowMin, photoUrl, thumbUrl } from '../lib/format';
import { store } from '../lib/store';
import { Photo, SourceBadge, TaxonName } from './bits';

export interface PopupItem {
  kind: Kind;
  i?: number; // row index (undefined for reports only known from live details)
  t: number;
  lngLat: [number, number];
  detail?: Detail;
}

const MAX = 6;

export function PopupContent({ items }: { items: PopupItem[] }) {
  return (
    <div className="pop">
      {items.slice(0, MAX).map(it => <Entry key={`${it.kind}-${it.i ?? it.detail?.u}`} item={it} />)}
      {items.length > MAX && <div className="moreitems">+ {items.length - MAX} more reports here — zoom in to separate them</div>}
    </div>
  );
}

function Entry({ item }: { item: PopupItem }) {
  const { kind, i } = item;
  const cols = i != null ? store.cols[kind] : undefined;
  const [d, setD] = useState<Detail | undefined>(item.detail);
  const [uuid, setUuid] = useState<string | undefined>(item.detail?.u);
  const [loading, setLoading] = useState(!item.detail && i != null);

  useEffect(() => {
    if (item.detail || i == null) return;
    let live = true;
    store.uuidAt(kind, i).then(u => live && setUuid(u));
    store.detailAt(kind, i).then(x => { if (live) { setD(x); setLoading(false); } });
    return () => { live = false; };
  }, [kind, i, item.detail]);

  const meta = store.meta!;
  const t = d ? isoMin(d.r) : cols && i != null ? cols.t[i] : item.t;
  const now = nowMin();
  const isNew = now - t < FRESH_MIN;
  const photos = d?.ph?.length ? (d.ip ? [d.ip, ...d.ph.filter(p => p !== d.ip)] : d.ph) : [];
  const lat = d?.la ?? item.lngLat[1], lon = d?.lo ?? item.lngLat[0];

  let title: React.ReactNode, sub: React.ReactNode = null;
  if (kind === 'obs') {
    const tx = d ? d.tx : cols && i != null ? cols.tx[i] : 0;
    const taxon = tx ? store.taxa.get(tx) : undefined;
    title = <><span className="sw" style={{ background: `var(--c-${taxon?.cat ?? 'unid'})` }} /><TaxonName taxon={taxon} /></>;
    sub = taxon ? (taxon.common || (taxon.cat === 'notmosq' ? 'not a mosquito' : null)) : 'no usable photo / not classified';
  } else if (kind === 'bites') {
    title = <><span className="sw sw-bites" /><span>Bite report{d?.n ? ` · ${d.n} bite${d.n > 1 ? 's' : ''}` : ''}</span></>;
    if (d?.bp && Object.keys(d.bp).length) sub = Object.entries(d.bp).map(([k, v]) => `${k.replace('_', ' ')}: ${v}`).join(', ');
  } else {
    const st = d?.st ?? (cols && i != null ? meta.site_types[cols.st[i]] : 'other');
    title = <><span className="sw sw-sites" /><span>Breeding site · {SITE_LABEL[st || 'other'] || st}</span></>;
    const w = d ? (d.w == null ? 2 : +d.w) : cols && i != null ? cols.w[i] : 2;
    sub = [w === 1 ? 'has water' : w === 0 ? 'no water' : null,
      d?.lv != null ? (d.lv ? 'larvae seen' : 'no larvae') : null,
      d?.nm ? 'mosquitoes nearby' : null].filter(Boolean).join(' · ');
  }

  return (
    <div className="it">
      {photos.length > 0 && (
        <div className="ph">
          {photos.slice(0, 2).map(p => {
            const full = photoUrl(meta.photo_prefix, p);
            return <a key={p} href={full} target="_blank" rel="noopener"><Photo src={thumbUrl(full, 560, 340)} full={full} alt="Report photo" /></a>;
          })}
        </div>
      )}
      <div className="tt">{title}{isNew && <span className="badge new">NEW</span>}</div>
      {sub && <div className="cn">{sub}</div>}
      {kind === 'obs' && d && (d.src || d.cl) && (
        <div className="kv"><div>
          <SourceBadge src={d.src} /> {d.cl}{d.cf != null ? ` (${Math.round(d.cf * 100)}%)` : ''}
          {d.na ? ` · ${d.na} expert annotation${d.na > 1 ? 's' : ''}` : ''}
        </div></div>
      )}
      {d?.pn && <div className="pn">{d.pn}</div>}
      <div className="kv">
        {d?.pl && <div>📍 {d.pl}</div>}
        <div>🕒 {d?.c ? `${d.c.replace('T', ' ')} local · ` : ''}received {ago(t, now)}{now - t < 30 * DAY ? ` (${fmtDateTime(t)})` : ''}</div>
        {d?.env && <div>{d.env === 'indoors' ? '🏠 Indoors' : '🌳 Outdoors'}</div>}
        {d?.no && <div>“{d.no}”</div>}
        {loading && <div className="muted">Loading details…</div>}
      </div>
      <div className="ln">
        <span>{lat.toFixed(4)}, {lon.toFixed(4)}</span>
        {uuid && <a href={store.recordUrl(kind, uuid)} target="_blank" rel="noopener">{d?.s ? `Record ${d.s}` : 'Full record'}</a>}
      </div>
    </div>
  );
}
