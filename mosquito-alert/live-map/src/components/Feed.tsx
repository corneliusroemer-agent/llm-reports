import { FRESH_MIN, SITE_LABEL } from '../config';
import { ago, fmtN, photoUrl, thumbUrl } from '../lib/format';
import type { FeedItem } from '../lib/stats';
import { store } from '../lib/store';
import { Badge, HINT, Photo, Section, SourceBadge, Swatch } from './bits';

const THUMB = 'grid size-14 shrink-0 place-items-center rounded-md bg-grid object-cover text-[22px] text-muted';

export function Feed({ items, limit, onMore, onPick, now, inView, note }: {
  items: FeedItem[]; limit: number; onMore(): void; onPick(it: FeedItem): void; now: number; inView: boolean; note: string;
}) {
  return (
    <Section title="Latest reports" aside={<span className={HINT}>{items.length ? `${fmtN(items.length)}${inView ? ' in view' : ''}` : ''}</span>}>
      <ol className="m-0 list-none p-0">
        {items.slice(0, limit).map(it => <Row key={`${it.kind}-${it.d.u}`} it={it} now={now} onPick={onPick} />)}
      </ol>
      {items.length > limit && (
        <button className="mt-1.5 w-full rounded-lg border border-line bg-raised p-1.5 hover:bg-wash" onClick={onMore}>Show more</button>
      )}
      {note && <p className="text-xs text-muted">{note}</p>}
    </Section>
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
    <li tabIndex={0} onClick={() => onPick(it)} onKeyDown={e => { if (e.key === 'Enter') onPick(it); }}
      className="flex cursor-pointer items-start gap-2.5 rounded-lg px-1.5 py-2 outline-none hover:bg-wash focus-visible:bg-wash">
      {pic
        ? <Photo className={THUMB} src={thumbUrl(full, 112, 112)} full={full} alt="" />
        : <div className={THUMB} aria-hidden="true">{kind === 'bites' ? '🦟' : kind === 'sites' ? '💧' : '?'}</div>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 font-semibold">
          {kind === 'obs' ? <Swatch small color={`var(--c-${taxon?.cat ?? 'unid'})`} /> : <Swatch small kind={kind} />}
          <span>{title}</span>
        </div>
        <div className="truncate text-[12.5px] text-ink-2">{d.pl || `${d.la.toFixed(3)}, ${d.lo.toFixed(3)}`}</div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {now - t < FRESH_MIN && <Badge tone="new">NEW</Badge>}
          <span title={new Date(t * 60000).toLocaleString()}>{ago(t, now)}</span>
          {kind === 'obs' && <SourceBadge src={d.src} />}
          {kind === 'obs' && d.cl && <span>{d.cl}</span>}
          {taxon?.common && <i>{taxon.name}</i>}
        </div>
      </div>
    </li>
  );
}
