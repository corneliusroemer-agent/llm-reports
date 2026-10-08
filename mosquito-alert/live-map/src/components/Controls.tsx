import { CATS, DAY, KINDS, KIND_LABEL, RANGES, RANGE_LABEL, type CatKey, type Kind, type RangeKey } from '../config';
import { fmtDate, fmtN } from '../lib/format';
import type { Mode, UiState } from '../lib/hashState';
import type { Counts } from '../lib/stats';
import { CHIP, HINT, ROW, Section, Swatch, cx } from './bits';

type SetUi = (f: (ui: UiState) => UiState) => void;
const dayMin = (s: string) => Date.parse(s + 'T00:00:00Z') / 60000;
const DATE_INPUT = 'rounded-md border border-line bg-raised px-1 py-0.5 text-[12.5px] text-ink';

export function TimeRange({ ui, setUi, window: [from], now, firstT }: {
  ui: UiState; setUi: SetUi; window: [number, number]; now: number; firstT: number | null;
}) {
  const fromVal = from > 0 ? fmtDate(from) : firstT != null ? fmtDate(firstT) : '';
  const toVal = ui.range === 'custom' && ui.to ? fmtDate(ui.to - DAY) : fmtDate(now);
  const setCustom = (f: string, t: string) => setUi(u => ({
    ...u, range: 'custom', from: f ? dayMin(f) : null, to: t ? dayMin(t) + DAY : null,
  }));
  return (
    <Section title="Time range">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Time range">
        {(Object.keys(RANGES) as RangeKey[]).map(r => (
          <button key={r} role="radio" aria-checked={ui.range === r} className={CHIP}
            onClick={() => setUi(u => ({ ...u, range: r, from: null, to: null }))}>{RANGE_LABEL[r]}</button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2.5 text-xs text-ink-2">
        <label className="flex items-center gap-1">From <input type="date" className={DATE_INPUT} value={fromVal} onChange={e => setCustom(e.target.value, toVal)} /></label>
        <label className="flex items-center gap-1">To <input type="date" className={DATE_INPUT} value={toVal} onChange={e => setCustom(fromVal, e.target.value)} /></label>
      </div>
    </Section>
  );
}

export function Layers({ ui, setUi, counts, loaded }: {
  ui: UiState; setUi: SetUi; counts: Counts; loaded: Partial<Record<Kind, boolean>>;
}) {
  return (
    <Section title="Layers">
      <div className="flex flex-col gap-0.5">
        {KINDS.map(k => (
          <label key={k} className={ROW}>
            <input type="checkbox" className="m-0 accent-accent" checked={ui.layers[k]}
              onChange={e => { const on = e.target.checked; setUi(u => ({ ...u, layers: { ...u.layers, [k]: on } })); }} />
            <Swatch kind={k} />
            <span className={cx('min-w-0 flex-1', !ui.layers[k] && 'text-muted')}>{KIND_LABEL[k]}</span>
            <span className="text-[12.5px] tabular-nums text-ink-2">{ui.layers[k] ? (loaded[k] ? fmtN(counts.kinds[k] ?? 0) : '…') : ''}</span>
          </label>
        ))}
      </div>
      <div className="mt-2 inline-flex gap-1.5" role="radiogroup" aria-label="Display">
        {(['points', 'heat'] as Mode[]).map(m => (
          <button key={m} role="radio" aria-checked={ui.mode === m} className={CHIP} onClick={() => setUi(u => ({ ...u, mode: m }))}>
            {m === 'points' ? 'Points' : 'Heatmap'}
          </button>
        ))}
      </div>
    </Section>
  );
}

export function Categories({ ui, setUi, counts, scope, loaded }: {
  ui: UiState; setUi: SetUi; counts: Counts; scope: string; loaded: boolean;
}) {
  const toggle = (k: CatKey, on: boolean) => setUi(u => {
    const cats = new Set(u.cats);
    if (on) cats.add(k); else cats.delete(k);
    return { ...u, cats };
  });
  return (
    <Section title="Mosquito type" aside={<span className={HINT}>{scope}</span>}>
      <div className="flex flex-col gap-0.5">
        {CATS.map((c, i) => {
          const on = ui.cats.has(c.k);
          return (
            <label key={c.k} className={ROW}>
              <input type="checkbox" className="m-0 accent-accent" checked={on} onChange={e => toggle(c.k, e.target.checked)} />
              <Swatch color={`var(--c-${c.k})`} />
              <span className={cx('min-w-0 flex-1', !on && 'text-muted')}>
                {c.label}<small className="ml-1 text-muted">{c.sub}</small>
              </span>
              <button className="invisible px-0.5 text-[11.5px] text-accent group-hover:visible" title={`Show only ${c.label}`}
                onClick={e => { e.preventDefault(); setUi(u => ({ ...u, cats: new Set([c.k]) })); }}>only</button>
              <span className={cx('text-[12.5px] tabular-nums', on ? 'text-ink-2' : 'text-muted')}>{loaded ? fmtN(counts.cats[i]) : ''}</span>
            </label>
          );
        })}
      </div>
    </Section>
  );
}
