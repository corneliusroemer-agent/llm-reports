import { CATS, DAY, KINDS, KIND_LABEL, RANGES, RANGE_LABEL, type CatKey, type Kind, type RangeKey } from '../config';
import { fmtDate, fmtN } from '../lib/format';
import type { Mode, UiState } from '../lib/hashState';
import type { Counts } from '../lib/stats';

type SetUi = (f: (ui: UiState) => UiState) => void;
const dayMin = (s: string) => Date.parse(s + 'T00:00:00Z') / 60000;

export function TimeRange({ ui, setUi, window: [from], now, firstT }: {
  ui: UiState; setUi: SetUi; window: [number, number]; now: number; firstT: number | null;
}) {
  const fromVal = from > 0 ? fmtDate(from) : firstT != null ? fmtDate(firstT) : '';
  const toVal = ui.range === 'custom' && ui.to ? fmtDate(ui.to - DAY) : fmtDate(now);
  const setCustom = (f: string, t: string) => setUi(u => ({
    ...u, range: 'custom', from: f ? dayMin(f) : null, to: t ? dayMin(t) + DAY : null,
  }));
  return (
    <section>
      <h2>Time range</h2>
      <div className="chips" role="radiogroup" aria-label="Time range">
        {(Object.keys(RANGES) as RangeKey[]).map(r => (
          <button key={r} role="radio" aria-checked={ui.range === r}
            onClick={() => setUi(u => ({ ...u, range: r, from: null, to: null }))}>{RANGE_LABEL[r]}</button>
        ))}
      </div>
      <div className="custom">
        <label>From <input type="date" value={fromVal} onChange={e => setCustom(e.target.value, toVal)} /></label>
        <label>To <input type="date" value={toVal} onChange={e => setCustom(fromVal, e.target.value)} /></label>
      </div>
    </section>
  );
}

export function Layers({ ui, setUi, counts, loaded }: {
  ui: UiState; setUi: SetUi; counts: Counts; loaded: Partial<Record<Kind, boolean>>;
}) {
  return (
    <section>
      <h2>Layers</h2>
      <div className="list">
        {KINDS.map(k => (
          <label key={k} className={`row${ui.layers[k] ? '' : ' off'}`}>
            <input type="checkbox" checked={ui.layers[k]}
              onChange={e => { const on = e.target.checked; setUi(u => ({ ...u, layers: { ...u.layers, [k]: on } })); }} />
            <span className={`sw sw-${k}`} />
            <span className="lbl">{KIND_LABEL[k]}</span>
            <span className="num">{ui.layers[k] ? (loaded[k] ? fmtN(counts.kinds[k] ?? 0) : '…') : ''}</span>
          </label>
        ))}
      </div>
      <div className="seg" role="radiogroup" aria-label="Display">
        {(['points', 'heat'] as Mode[]).map(m => (
          <button key={m} role="radio" aria-checked={ui.mode === m} onClick={() => setUi(u => ({ ...u, mode: m }))}>
            {m === 'points' ? 'Points' : 'Heatmap'}
          </button>
        ))}
      </div>
    </section>
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
    <section>
      <div className="h2-row"><h2>Mosquito type</h2><span className="hint">{scope}</span></div>
      <div className="list">
        {CATS.map((c, i) => {
          const on = ui.cats.has(c.k);
          return (
            <label key={c.k} className={`row${on ? '' : ' off'}`}>
              <input type="checkbox" checked={on} onChange={e => toggle(c.k, e.target.checked)} />
              <span className="sw" style={{ background: `var(--c-${c.k})` }} />
              <span className="lbl">{c.label}<small>{c.sub}</small></span>
              <button className="only" title={`Show only ${c.label}`}
                onClick={e => { e.preventDefault(); setUi(u => ({ ...u, cats: new Set([c.k]) })); }}>only</button>
              <span className="num">{loaded ? fmtN(counts.cats[i]) : ''}</span>
            </label>
          );
        })}
      </div>
    </section>
  );
}
