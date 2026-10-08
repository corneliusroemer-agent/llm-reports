import { useLayoutEffect, useRef, useState } from 'react';
import { DAY } from '../config';
import { fmtN } from '../lib/format';
import type { Bins } from '../lib/stats';

const H = 120, PAD_L = 30, PAD_B = 18, PAD_T = 6;

function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return Math.max(2, m * p);
  return v;
}

function label(bins: Bins, k: number) {
  const d = new Date(bins.starts[k] * 60000);
  if (bins.unit === 'hour') return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' });
  if (bins.unit === 'month') return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', timeZone: 'UTC' });
  return d.toLocaleDateString(undefined, { year: bins.span > 300 * DAY ? 'numeric' : undefined, month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Single-series bar chart of mosquito reports per time bin, with hover tooltip. */
export function ActivityChart({ bins }: { bins: Bins | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(340);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 340));
    ro.observe(el);
    setW(el.clientWidth || 340);
    return () => ro.disconnect();
  }, []);

  if (!bins) return <div className="chart" ref={box} />;
  const { values } = bins;
  const nb = values.length;
  const nice = niceMax(Math.max(1, ...values));
  const bw = (W - PAD_L) / nb;
  const gap = bw > 4 ? 2 : bw > 2 ? 1 : 0;
  const y = (v: number) => PAD_T + (H - PAD_B - PAD_T) * (1 - v / nice);
  const r = Math.min(4, Math.max(0, (bw - gap) / 2));

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const k = Math.floor(((e.clientX - rect.left) * (W / rect.width) - PAD_L) / bw);
    setHover(k >= 0 && k < nb ? k : null);
  };

  return (
    <div className="chart" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Mosquito reports per ${bins.unit}`}
        onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {hover != null && <rect x={PAD_L + hover * bw} y={0} width={bw} height={H - PAD_B} fill="var(--wash)" />}
        {[0, nice / 2, nice].map(v => (
          <g key={v}>
            <line x1={PAD_L} x2={W} y1={y(v)} y2={y(v)} stroke={v ? 'var(--grid)' : 'var(--axis)'} strokeWidth={1} />
            <text x={PAD_L - 5} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)">{fmtN(v)}</text>
          </g>
        ))}
        {values.map((v, k) => {
          if (!v) return null;
          const x = PAD_L + k * bw + gap / 2, w = Math.max(0.8, bw - gap), top = y(v), base = y(0);
          const rr = Math.min(r, base - top);
          return <path key={k} fill="var(--bar)"
            d={`M${x},${base}V${top + rr}q0,${-rr} ${rr},${-rr}h${w - 2 * rr}q${rr},0 ${rr},${rr}V${base}Z`} />;
        })}
        <text x={PAD_L} y={H - 4} fontSize={10} fill="var(--muted)">{label(bins, 0)}</text>
        <text x={W} y={H - 4} fontSize={10} textAnchor="end" fill="var(--muted)">{label(bins, nb - 1)}</text>
      </svg>
      {hover != null && (
        <div className="tip" style={{ left: Math.min(Math.max((PAD_L + (hover + 0.5) * bw) * ((box.current?.clientWidth || W) / W), 70), (box.current?.clientWidth || W) - 70) }}>
          {label(bins, hover)}{bins.unit === 'week' ? ' (week)' : ''}: <b>{fmtN(values[hover])}</b>
        </div>
      )}
    </div>
  );
}
