// TypeScript port of fetch.py's `slim`, applied to records fetched live.
import type { Kind } from '../config';
import type { ApiRecord, Detail } from '../types';

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

export function slim(kind: Kind, d: ApiRecord, photoPrefix: string): Detail {
  const loc = d.location;
  const strip = (u: string) => (u.startsWith(photoPrefix) ? u.slice(photoPrefix.length) : u);
  const s: Detail = {
    u: d.uuid,
    s: d.short_id,
    r: d.received_at.slice(0, 19) + 'Z',
    c: (d.created_at_local || '').slice(0, 16),
    la: r5(loc.point.latitude),
    lo: r5(loc.point.longitude),
    pl: loc.display_name,
    cc: loc.country?.name_en,
    ls: loc.source,
  };
  if (d.note) s.no = d.note.slice(0, 500);
  if (kind !== 'bites') s.ph = (d.photos || []).map(p => strip(p.url));
  if (kind === 'obs') {
    const ident = d.identification || {};
    const res = ident.result || {};
    s.tx = res.taxon?.id ?? null;
    s.src = res.source;
    s.cl = res.confidence_label;
    if (res.confidence != null) s.cf = Math.round(res.confidence * 1000) / 1000;
    s.na = ident.num_annotations;
    if (ident.public_note) s.pn = ident.public_note.slice(0, 800);
    if (ident.photo?.url) s.ip = strip(ident.photo.url);
    s.env = d.event_environment;
  } else if (kind === 'bites') {
    const c = d.counts || {};
    s.n = c.total;
    s.bp = Object.fromEntries(Object.entries(c).filter(([k, v]) => k !== 'total' && v));
    s.env = d.event_environment;
    s.mo = d.event_moment;
  } else {
    s.st = d.site_type;
    if (d.has_water != null) s.w = d.has_water;
    if (d.has_larvae != null) s.lv = d.has_larvae;
    if (d.has_near_mosquitoes != null) s.nm = d.has_near_mosquitoes;
    if (d.in_public_area != null) s.pa = d.in_public_area;
  }
  return s;
}
