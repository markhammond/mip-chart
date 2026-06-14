// Recipe-defined hover label formatting (inspired by the Plotly-style
// hovertemplate convention — but a TYPED, injection-free subset rendered to
// plain text).
//
// Placeholders:
//   {label}                 series label
//   {value} {value:FMT}     the series' primary value
//   {col.NAME} {col.NAME:FMT}  another column of the same series at this row
//   {x} {x:date:PATTERN}    the point's UTC timestamp
//   {state}                 the pane's StateName for the (rounded) value
//   {sign:POS|NEG}          POS when value ≥ 0, NEG when < 0 (verb pick,
//                           e.g. {sign:Up|Down} on a signed value)
// FMT:
//   .Nf   fixed N decimals            (.2f → 12.35)
//   .Ns   SI-scaled with N decimals   (.3s → 73.441k)
//   .N%   percent ×100, N decimals    (.4% → 0.0067%)
//   .Nbp  basis points ×10000         (.2bp → 0.67bps)
// PATTERN tokens: YYYY MM DD HH mm  (UTC)
// '\n' in a template yields additional (indented) tooltip rows.

export interface HoverContext {
  label: string;
  x: number;
  value: number | null;
  column(name: string): number | null;
  stateName?: string | null;
}

const SI_STEPS: Array<[number, string]> = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'k'],
];

export function formatHoverNumber(v: number | null, fmt?: string): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (fmt) {
    const m = /^\.(\d)(f|s|%|bp)$/.exec(fmt);
    if (m) {
      const n = Number(m[1]);
      switch (m[2]) {
        case 'f':
          return v.toFixed(n);
        case '%':
          return (v * 100).toFixed(n) + '%';
        case 'bp':
          return (v * 10_000).toFixed(n) + 'bps';
        case 's': {
          for (const [scale, suffix] of SI_STEPS) {
            if (Math.abs(v) >= scale) return (v / scale).toFixed(n) + suffix;
          }
          return v.toFixed(n);
        }
      }
    }
  }
  // default: compact native formatting
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}

export function formatHoverDate(ms: number, pattern: string): string {
  const d = new Date(ms);
  return pattern
    .replace('YYYY', String(d.getUTCFullYear()))
    .replace('MM', String(d.getUTCMonth() + 1).padStart(2, '0'))
    .replace('DD', String(d.getUTCDate()).padStart(2, '0'))
    .replace('HH', String(d.getUTCHours()).padStart(2, '0'))
    .replace('mm', String(d.getUTCMinutes()).padStart(2, '0'));
}

/** Render a hover template against a point context. Unknown placeholders
 *  render as '—' (never throw — templates are recipe data). */
export function renderHoverTemplate(template: string, ctx: HoverContext): string {
  return template.replace(/\{([^{}]+)\}/g, (_all, body: string) => {
    const [head, ...rest] = body.split(':');
    const fmt = rest.join(':') || undefined;
    switch (head) {
      case 'label':
        return ctx.label;
      case 'value':
        return formatHoverNumber(ctx.value, fmt);
      case 'state':
        return ctx.stateName ?? '—';
      case 'sign': {
        if (ctx.value == null || !Number.isFinite(ctx.value)) return '—';
        const [pos, neg] = (fmt ?? '').split('|');
        return (ctx.value >= 0 ? pos : neg) || '—';
      }
      case 'x':
        if (fmt?.startsWith('date:')) return formatHoverDate(ctx.x, fmt.slice(5));
        return new Date(ctx.x).toISOString();
      default:
        if (head!.startsWith('col.')) {
          return formatHoverNumber(ctx.column(head!.slice(4)), fmt);
        }
        return '—';
    }
  });
}
