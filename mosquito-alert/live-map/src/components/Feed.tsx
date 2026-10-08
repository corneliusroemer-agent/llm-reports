import { FRESH_MIN, SITE_LABEL } from '../config';
import { ago, fmtN, photoUrl, thumbUrl } from '../lib/format';
import type { FeedItem } from '../lib/stats';
import { store } from '../lib/store';
import { Photo, SourceBadge } from './bits';

export function Feed({ items, limit, onMore, onPick, now, inView, note }: {
  items: FeedItem[]; limit: number; onMore(): void; onPick(it: FeedItem): void; now: number; inView: boolean; note: string;
}) {
  return (
    <section className="feed-sec">
      <div className="h2-row">
        <h2>Latest reports</h2>
        <span className="hint">{items.length ? `${fmtN(items.length)}${inView ? ' in view' : ''}` : ''}</span>
      </div>
      <ol className="feed">
        {items.slice(0, limit).map(it => <Row key={`${it.kind}-${it.d.u}`} it={it} now={now} onPick={onPick} />)}
      </ol>
      {items.length > limit && <button className="more" onClick={onMore}>Show more</button>}
      {note && <p className="note">{note}</p>}
    </section>
  );
}

function Row({ it, now, onPick }: { it: FeedItem; now: number; onPick(it: FeedItem): void }) {
  const { kind, d, t } = it;
  const meta = store.meta!;
  const pic = d.ip || d.ph?.[0];
  const taxon = kind === 'obs' && d.tx ? store.taxa.get(d.tx) : undefined;
  let title: string;
  if (kind === 'obs') {
    title = taxon ? (taxon.common || (taxon.cat === 'notmosq' ? `Not a mosquito (${taxon.name})` : taxon.name)) : 'Unidentified';
  } else if (kind === 'bites') {
    title = `Bite report${d.n ? ` · ${d.n}` : ''}`;
  } else {
    title = `Breeding site · ${SITE_LABEL[d.st || 'other'] || d.st}`;
  }
  const full = pic ? photoUrl(meta.photo_prefix, pic) : '';
  return (
    <li tabIndex={0} onClick={() => onPick(it)} onKeyDown={e => { if (e.key === 'Enter') onPick(it); }}>
      {pic
        ? <Photo className="thumb" src={thumbUrl(full, 112, 112)} full={full} alt="" />
        : <div className="thumb" aria-hidden="true">{kind === 'bites' ? '🦟' : kind === 'sites' ? '💧' : '?'}</div>}
      <div className="fi">
        <div className="t">
          {kind === 'obs'
            ? <span className="cd" style={{ background: `var(--c-${taxon?.cat ?? 'unid'})` }} />
            : <span className={`cd sw sw-${kind}`} />}
          <span>{title}</span>
        </div>
        <div className="p">{d.pl || `${d.la.toFixed(3)}, ${d.lo.toFixed(3)}`}</div>
        <div className="m">
          {now - t < FRESH_MIN && <span className="badge new">NEW</span>}
          <span title={new Date(t * 60000).toLocaleString()}>{ago(t, now)}</span>
          {kind === 'obs' && <SourceBadge src={d.src} />}
          {kind === 'obs' && d.cl && <span>{d.cl}</span>}
          {taxon?.common && <i>{taxon.name}</i>}
        </div>
      </div>
    </li>
  );
}
