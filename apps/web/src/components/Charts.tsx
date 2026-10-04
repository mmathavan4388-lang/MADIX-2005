/** Tiny dependency-free SVG charts (accessible, theme-aware). */
const W = 640, H = 200, PAD = 28;
export function LineChart({ data, series, label }: { data: Record<string, any>[]; series: { key: string; color: string; name: string }[]; label: string }) {
  if (!data.length) return null;
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0)));
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / Math.max(1, data.length - 1);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {[0, 0.5, 1].map((f) => <g key={f}><line x1={PAD} x2={W - PAD} y1={y(max * f)} y2={y(max * f)} stroke="rgba(255,255,255,.07)" /><text x={0} y={y(max * f) + 3}>{Math.round(max * f)}</text></g>)}
        {series.map((s) => {
          const pts = data.map((d, i) => `${x(i)},${y(Number(d[s.key]) || 0)}`).join(' ');
          return <g key={s.key}><polyline points={pts} fill="none" stroke={s.color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />{data.length < 40 && data.map((d, i) => <circle key={i} cx={x(i)} cy={y(Number(d[s.key]) || 0)} r="2.4" fill={s.color}><title>{`${d.day?.slice?.(5, 10) ?? i}: ${d[s.key]}`}</title></circle>)}</g>;
        })}
        {data.filter((_, i) => i % Math.ceil(data.length / 6) === 0).map((d) => <text key={d.day} x={x(data.indexOf(d))} y={H - 6} textAnchor="middle">{String(d.day).slice(5, 10)}</text>)}
      </svg>
      <figcaption className="row gap wrap" style={{ fontSize: '.8rem' }}>{series.map((s) => <span key={s.key} className="row" style={{ gap: 6 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: s.color }} />{s.name}</span>)}</figcaption>
    </figure>
  );
}
export function BarList({ rows, color = 'var(--primary)' }: { rows: { name: string; n: number }[]; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return <div className="stack" style={{ gap: 10 }}>{rows.map((r) => <div key={r.name}><div className="row between" style={{ fontSize: '.85rem' }}><span>{r.name}</span><b>{r.n}</b></div><div className="progress"><i style={{ width: `${(r.n / max) * 100}%`, background: color }} /></div></div>)}</div>;
}
