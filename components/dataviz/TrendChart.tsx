'use client';

import { useState } from 'react';
import { faNum } from './fa';

export interface TrendPoint {
  /** برچسب فارسی نقطه، مثلاً شماره چرخه */
  label: string;
  value: number;
}

export interface TrendChartProps {
  title: string;
  /** برچسب محور عمودی برای تولتیپ، مثلاً «فراخوانی LLM» */
  unit?: string;
  points: TrendPoint[];
  className?: string;
}

/**
 * نمودار خطی سبک روند (SVG خالص، بدون وابستگی خارجی):
 * زمان از راست به چپ (مناسب راست‌چین)، لیبل‌های فارسی، تولتیپ لمسی و موس.
 */
export default function TrendChart({
  title,
  unit,
  points,
  className = '',
}: TrendChartProps) {
  const [hover, setHover] = useState<number | null>(null);

  const W = 560;
  const H = 220;
  const PAD_R = 14; // راست
  const PAD_L = 44; // چپ (فضای اعداد محور)
  const PAD_T = 14;
  const PAD_B = 34;

  if (points.length < 2) {
    return (
      <div className={`rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted-foreground ${className}`}>
        داده‌ای برای رسم نمودار نیست.
      </div>
    );
  }

  const values = points.map((p) => p.value);
  const max = Math.max(...values, 1);
  const min = 0;
  const span = max - min || 1;

  const iw = W - PAD_R - PAD_L;
  const ih = H - PAD_T - PAD_B;

  // زمان راست‌به‌چپ: قدیمی‌ترین نقطه راست، جدیدترین چپ
  const xy = (i: number, v: number): [number, number] => {
    const x = PAD_R + iw - (i / (points.length - 1)) * iw;
    const y = PAD_T + ih - ((v - min) / span) * ih;
    return [x, y];
  };

  const line = points
    .map((p, i) => {
      const [x, y] = xy(i, p.value);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const [fx, fy] = xy(0, values[0]);
  const area = `${line} L${fx.toFixed(1)},${(PAD_T + ih).toFixed(1)} Z`;

  // ۴ خط شبکهٔ افقی با اعداد فارسی
  const ticks = [0, 1, 2, 3, 4].map((t) => {
    const v = min + (span * t) / 4;
    return { v, y: PAD_T + ih - (t / 4) * ih };
  });

  const hp = hover !== null ? points[hover] : null;
  const [hx, hy] = hover !== null ? xy(hover, values[hover]) : [0, 0];

  return (
    <figure
      className={`rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-control)] sm:p-5 ${className}`}
      aria-label={title}
    >
      <figcaption className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-bold text-foreground">{title}</h3>
        {unit && (
          <span className="text-xs text-muted-foreground">{unit}</span>
        )}
      </figcaption>

      <div className="relative" dir="ltr">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-48 w-full sm:h-56"
          role="img"
          aria-label={`${title}: ${points
            .map((p) => `${p.label} ${faNum(p.value)}`)
            .join('، ')}`}
        >
          {ticks.map((t, i) => (
            <g key={i}>
              <line
                x1={PAD_R}
                x2={W - PAD_L}
                y1={t.y}
                y2={t.y}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                strokeDasharray={i === 0 ? undefined : '4 4'}
              />
              <text
                x={W - PAD_L + 8}
                y={t.y + 4}
                fontSize={11}
                fill="currentColor"
                className="text-muted-foreground"
              >
                {faNum(Math.round(t.v))}
              </text>
            </g>
          ))}

          <path d={area} fill="rgb(var(--brand) / 0.12)" />
          <path
            d={line}
            fill="none"
            stroke="rgb(var(--brand))"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {points.map((p, i) => {
            const [x, y] = xy(i, p.value);
            const isActive = hover === i;
            return (
              <g key={i}>
                <circle
                  cx={x}
                  cy={y}
                  r={isActive ? 9 : 14}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onClick={() => setHover(i)}
                  style={{ cursor: 'pointer' }}
                />
                <circle
                  cx={x}
                  cy={y}
                  r={isActive ? 5.5 : 4}
                  fill="rgb(var(--card))"
                  stroke="rgb(var(--brand))"
                  strokeWidth={2.5}
                  pointerEvents="none"
                />
                <text
                  x={x}
                  y={H - 12}
                  textAnchor="middle"
                  fontSize={11}
                  fill="currentColor"
                  className="text-muted-foreground"
                  pointerEvents="none"
                >
                  {p.label}
                </text>
              </g>
            );
          })}

          {hover !== null && (
            <line
              x1={hx}
              x2={hx}
              y1={PAD_T}
              y2={PAD_T + ih}
              stroke="rgb(var(--brand))"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.6}
            />
          )}
        </svg>

        {hp && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-xl border border-border bg-card px-3 py-1.5 text-center shadow-[var(--shadow-surface)]"
            style={{
              left: `${(hx / W) * 100}%`,
              top: `${Math.max(0, ((hy - 64) / H) * 100)}%`,
            }}
          >
            <div className="text-xs text-muted-foreground">{hp.label}</div>
            <div className="text-sm font-extrabold text-brand">
              {faNum(hp.value)}
              {unit ? ` ${unit}` : ''}
            </div>
          </div>
        )}
      </div>
    </figure>
  );
}
