// Spans example: session calendar shading with line breaks, earnings windows
// across every pane, and filing/release event lines — all generic vrect/vline
// series fed by the host like any other series.

import 'uplot/dist/uPlot.min.css';
import { ChartNavigator } from '../src/index';
import type { ViewRecipe } from '../src/index';
import {
  BAR_MS,
  EXTENT,
  FILING_TEXT,
  LAST_EARNINGS,
  STATE_NAMES,
  SessionProvider,
} from './sessionProvider';

const recipe: ViewRecipe = {
  id: 'demo-spans',
  background: '#ffffff',
  gridColor: '#eceef2',
  panes: [
    { id: 'price', heightWeight: 3, scale: 'linear', title: 'Sessions, earnings windows & filings — 5m regular-session bars' },
    { id: 'osc', heightWeight: 1.4, scale: 'linear', title: 'Momentum % · envelope (band) · regime (step)' },
    { id: 'state', heightWeight: 0.7, scale: 'linear', stateNames: STATE_NAMES, title: 'State lane' },
  ],
  series: [
    { key: 'candles', paneId: 'price', label: 'OHLC', color: '#26a69a', renderer: 'candlestick', columns: ['open', 'high', 'low', 'close'], baseline: true, baselineColumn: 'close', group: 'Price' },
    { key: 'vwap', paneId: 'price', label: 'VWAP', color: '#e2a714', renderer: 'line', columns: ['value'], group: 'Price' },
    { key: 'env', paneId: 'osc', label: 'Envelope', color: '#42a5f5', renderer: 'band', columns: ['upper', 'lower'], group: 'Indicators' },
    { key: 'mom', paneId: 'osc', label: 'Momentum', color: '#ab47bc', renderer: 'line', curve: 'linear', columns: ['value'], group: 'Indicators' },
    { key: 'regime', paneId: 'osc', label: 'Regime', color: '#6d4c41', renderer: 'line', step: true, columns: ['value'], group: 'Indicators' },
    { key: 'states', paneId: 'state', label: 'State', color: '#66bb6a', renderer: 'state-bars', columns: ['value'], group: 'Features' },
    {
      key: 'sessions', paneId: 'price', panes: 'all', label: 'Sessions', color: '#8a8a99',
      renderer: 'vrect', columns: ['end', 'category'],
      categories: [
        { name: 'Closed', fill: 'rgba(120,120,140,.08)', hatch: { pattern: 'diagonal', color: 'rgba(110,110,130,.32)', spacingPx: 6 }, breaks: true },
        { name: 'Overnight', fill: 'rgba(120,120,140,.07)', breaks: true },
      ],
      hoverTemplate: '{label}: {category}  {x:date:MM-DD HH:mm} → {col.end:date:MM-DD HH:mm}',
    },
    {
      key: 'earnings', paneId: 'price', panes: 'all', label: 'Earnings', color: '#3f51b5',
      renderer: 'vrect', columns: ['end', 'category'],
      categories: [
        { name: 'Pre-window', fill: 'rgba(63,81,181,.05)', hatch: { pattern: 'diagonal', color: 'rgba(63,81,181,.42)', spacingPx: 8 }, edge: { color: 'rgba(63,81,181,.75)', sides: 'start' }, label: { text: 'pre-earnings' } },
        { name: 'Post-window', fill: 'rgba(255,152,0,.13)', edge: { color: 'rgba(239,108,0,.8)', sides: 'end' }, label: { text: 'post-earnings', position: 'top' } },
      ],
      hoverTemplate: '{label}: {category} until {col.end:date:YYYY-MM-DD HH:mm}',
    },
    {
      key: 'events', paneId: 'price', panes: 'all', layer: 'above', label: 'Events', color: '#e53935',
      renderer: 'vline', columns: ['category'], minimapOverlay: true,
      categories: [
        { name: '8-K filing', edge: { color: '#e53935', widthPx: 1.25, dash: [4, 3] } },
        { name: 'Release', edge: { color: '#2e7d32', widthPx: 1.5 }, label: { text: 'release' } },
      ],
      hoverTemplate: '{label}: {category} @ {x:date:YYYY-MM-DD HH:mm}',
    },
  ],
};

const root = document.getElementById('chart')!;
root.style.height = `${Math.max(window.innerHeight - 110, 520)}px`;

const DAY = 86_400_000;
const provider = new SessionProvider((f) => nav.acceptFragment(f));
const nav = new ChartNavigator(root, {
  recipe,
  extent: EXTENT,
  barMs: BAR_MS,
  initialVisible: { from: LAST_EARNINGS - 11 * DAY, to: LAST_EARNINGS + 6 * DAY },
  hooks: {
    requestFrame: (req) => provider.serve(req),
    requestOverview: (req) => provider.serveOverview(req.maxPoints, (xs, ys) => nav.acceptOverview(xs, ys)),
    // Per-span text rides the existing lazy detail hook (seriesKey + span start).
    requestHoverDetail: (ref) =>
      new Promise((resolve) =>
        setTimeout(() => {
          if (ref.seriesKey === 'events') resolve(FILING_TEXT(ref.x));
          else if (ref.seriesKey === 'earnings') resolve('Consensus EPS 1.42 · prior 1.31');
          else if (ref.seriesKey === 'sessions') resolve(null);
          else resolve(null);
        }, 60),
      ),
  },
});

const RANGES: Record<string, number> = { '1d': DAY, '1w': 7 * DAY, '1m': 30 * DAY, '3m': 91 * DAY, '1y': 365 * DAY, '2y': 730 * DAY };
document.querySelectorAll<HTMLButtonElement>('#toolbar button[data-range]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const span = RANGES[btn.dataset['range']!]!;
    const { from, to } = nav.getVisible();
    const mid = (from + to) / 2;
    nav.navigateTo({ from: mid - span / 2, to: mid + span / 2 });
  });
});
// Offline snapshot round trip: serialize, parse, and render frozen (no hooks fire).
let frozen: ChartNavigator | null = null;
document.getElementById('snapshot')!.addEventListener('click', () => {
  const host = document.getElementById('frozen')!;
  frozen?.destroy();
  const snap = JSON.parse(JSON.stringify(nav.getSnapshot()));
  host.style.display = 'block';
  host.style.height = `${root.clientHeight}px`;
  frozen = new ChartNavigator(host, {
    snapshot: snap,
    recipe: snap.recipe,
    extent: snap.extent,
    barMs: snap.barMs,
    hooks: { requestFrame: () => {} },
  });
  host.scrollIntoView({ behavior: 'smooth' });
});

(window as unknown as Record<string, unknown>)['nav'] = nav;
(window as unknown as Record<string, unknown>)['frozen'] = () => frozen;
