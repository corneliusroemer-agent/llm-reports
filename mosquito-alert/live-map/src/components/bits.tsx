import type { Taxon } from '../types';

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
    ? <span className="badge ai" title="Automatic identification, not yet validated by experts">AI</span>
    : <span className="badge ex" title="Validated by experts">{src === 'expert' ? 'Expert' : src}</span>;
}
