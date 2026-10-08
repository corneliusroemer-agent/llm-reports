import type { ReactNode } from 'react';
import type { Kind } from '../config';
import type { Taxon } from '../types';

/** Shared Tailwind class strings. */
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export const H2 = 'mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-2';
export const CHIP = cx(
  'rounded-full border border-line bg-raised px-3 py-1 text-[13px] hover:bg-wash',
  'aria-checked:border-accent aria-checked:bg-accent aria-checked:font-semibold aria-checked:text-white',
);
export const ROW = 'group flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-wash';
export const HINT = 'text-xs text-muted';

export function Section({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('pt-3.5 pb-1', className)}>
      {(title || aside) && (
        <div className="flex items-baseline justify-between gap-2">
          <h2 className={H2}>{title}</h2>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

const RING = 'shadow-[0_0_0_1.5px_var(--surface),0_0_0_2.5px_var(--border)]';

/** Legend swatch: category colour, bite dot, or breeding-site ring. */
export function Swatch({ color, kind, small }: { color?: string; kind?: Kind; small?: boolean }) {
  const size = small ? 'size-[9px]' : 'size-3';
  if (kind === 'sites') return <span className={cx(size, 'shrink-0 rounded-full border-[2.5px] border-sites', !small && RING)} />;
  if (kind === 'bites') return <span className={cx(small ? 'size-[8px]' : 'mx-[1.5px] size-[9px]', 'shrink-0 rounded-full bg-bites', !small && RING)} />;
  if (kind === 'obs') {
    return <span className={cx(size, 'shrink-0 rounded-full', RING)} style={{
      background: 'conic-gradient(var(--c-albo) 0 25%, var(--c-aegypti) 0 45%, var(--c-japkor) 0 65%, var(--c-culex) 0 85%, var(--c-othermosq) 0)',
    }} />;
  }
  return <span className={cx(size, 'shrink-0 rounded-full', !small && RING)} style={{ background: color }} />;
}

type BadgeTone = 'ai' | 'expert' | 'new';
const BADGE: Record<BadgeTone, string> = {
  ai: 'bg-wash text-accent',
  expert: 'bg-[rgba(12,163,12,0.14)] text-ink',
  new: 'bg-ink text-surface',
};
export function Badge({ tone, title, children }: { tone: BadgeTone; title?: string; children: ReactNode }) {
  return <span title={title} className={cx('rounded px-1.5 text-[10.5px] font-semibold tracking-[0.02em]', BADGE[tone])}>{children}</span>;
}

/** Thumbnail that falls back to the original photo if the resizing proxy fails. */
export function Photo({ src, full, alt, className }: { src: string; full: string; alt: string; className?: string }) {
  return (
    <img
      className={className}
      loading="lazy"
      alt={alt}
      src={src}
      onError={e => { const img = e.currentTarget; if (img.src !== full) img.src = full; }}
    />
  );
}

export function TaxonName({ taxon }: { taxon: Taxon | undefined }) {
  if (!taxon) return <span>Unidentified</span>;
  return taxon.it ? <i>{taxon.name}</i> : <span>{taxon.name}</span>;
}

export function SourceBadge({ src }: { src?: string | null }) {
  if (!src) return null;
  return src === 'ai'
    ? <Badge tone="ai" title="Automatic identification, not yet validated by experts">AI</Badge>
    : <Badge tone="expert" title="Validated by experts">{src === 'expert' ? 'Expert' : src}</Badge>;
}
