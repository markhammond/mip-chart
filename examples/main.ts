// Live example driver — a plain-JS host. Wires the ChartNavigator's plain-JS
// hooks to the synthetic provider exactly the way a host application wires them
// to its data source.

import 'uplot/dist/uPlot.min.css';
import { ChartNavigator } from '../src/index';
import type { NavigationRequest, PointRef, ViewRecipe } from '../src/index';
import { BAR_MS, EXTENT, STATE_NAMES, SyntheticProvider } from './provider';

const logEl = document.getElementById('log')!;
const statusEl = document.getElementById('status')!;
const log = (msg: string) => {
  const line = document.createElement('div');
  line.textContent = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  logEl.prepend(line);
  while (logEl.childElementCount > 200) logEl.lastElementChild!.remove();
};

const recipe: ViewRecipe = {
  id: 'demo-market',
  panes: [
    { id: 'price', heightWeight: 3, scale: 'log', title: 'Price (log) — candles + VWAP' },
    { id: 'osc', heightWeight: 1.2, scale: 'linear', title: 'EMA 20 / 96' },
    { id: 'state', heightWeight: 0.8, scale: 'linear', stateNames: STATE_NAMES, title: 'State lane' },
  ],
  series: [
    { key: 'candles', paneId: 'price', label: 'OHLC', color: '#26a69a', renderer: 'candlestick', columns: ['open', 'high', 'low', 'close'], baseline: true, baselineColumn: 'close', group: 'Observables', actions: [{ id: 'open-bar-analysis', label: 'Open bar analysis' }] },
    { key: 'vwap', paneId: 'price', label: 'VWAP', color: '#e2b714', renderer: 'line', columns: ['value'], group: 'Observables' },
    { key: 'emaFast', paneId: 'osc', label: 'EMA20', color: '#42a5f5', renderer: 'line', columns: ['value'], group: 'Indicators' },
    { key: 'emaSlow', paneId: 'osc', label: 'EMA96', color: '#ab47bc', renderer: 'line', columns: ['value'], group: 'Indicators' },
    { key: 'states', paneId: 'state', label: 'State', color: '#66bb6a', renderer: 'state-bars', columns: ['valid'], group: 'Features' },
    { key: 'states-invalid', paneId: 'state', label: 'Invalid', color: '#ef5350', renderer: 'markers', columns: ['invalid'], group: 'Features' },
  ],
};

const root = document.getElementById('chart')!;
root.style.height = `${Math.max(window.innerHeight - 160, 480)}px`;

// One key per fragment — the fragment contract.
const provider = new SyntheticProvider((f) => navigator_.acceptFragment(f), log);

const navigator_ = new ChartNavigator(root, {
  recipe,
  extent: EXTENT,
  barMs: BAR_MS,
  hooks: {
    requestFrame: (req: NavigationRequest) => provider.serve(req),
    requestOverview: (req) =>
      provider.serveOverview(req.maxPoints, (xs, ys) => navigator_.acceptOverview(xs, ys)),
    requestHoverDetail: (ref: PointRef, signal: AbortSignal) =>
      new Promise<string | null>((resolve) => {
        // Simulated server-side per-point detail: debounced upstream,
        // supersede-cancellable here.
        const t = setTimeout(
          () => resolve(`detail[${ref.seriesKey}] @ ${new Date(ref.x).toISOString()}\n(lazy-fetched)`),
          120,
        );
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve(null);
        });
      }),
    onPointAction: (actionId, ref) =>
      log(`point action: ${actionId} on ${ref.seriesKey} @ ${new Date(ref.x).toISOString()}`),
    onStatus: (s, detail) => {
      statusEl.textContent = detail ? `${s}: ${detail}` : s;
      statusEl.className = s;
    },
  },
});

// ---------------------------------------------------------------- toolbar

const RANGES: Record<string, number> = {
  '3h': 3 * 3600e3,
  '6h': 6 * 3600e3,
  '1d': 24 * 3600e3,
  '1w': 7 * 24 * 3600e3,
  '1m': 30 * 24 * 3600e3,
  '6m': 182 * 24 * 3600e3,
};

document.querySelectorAll<HTMLButtonElement>('#toolbar button[data-range]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const span = RANGES[btn.dataset['range']!]!;
    const { to } = navigator_.getVisible();
    navigator_.navigateTo({ from: to - span, to });
  });
});

(document.getElementById('jump') as HTMLInputElement).addEventListener('change', (e) => {
  const v = (e.target as HTMLInputElement).value;
  if (!v) return;
  const center = Date.parse(v + 'T00:00:00Z');
  const { from, to } = navigator_.getVisible();
  const half = (to - from) / 2;
  navigator_.navigateTo({ from: center - half, to: center + half });
});

(document.getElementById('pct') as HTMLInputElement).addEventListener('change', (e) => {
  navigator_.setPercentMode((e.target as HTMLInputElement).checked);
});

(document.getElementById('baseline-vis') as HTMLInputElement).addEventListener('change', (e) => {
  // Anchor test: hiding the baseline series (candles → close) must NOT
  // move the % origin.
  navigator_.setSeriesVisible('candles', (e.target as HTMLInputElement).checked);
});

log(`extent ${new Date(EXTENT.from).toISOString()} → ${new Date(EXTENT.to).toISOString()}`);

// Example debugging hooks (not part of the library surface).
(window as unknown as Record<string, unknown>)['nav'] = navigator_;
(window as unknown as Record<string, unknown>)['providerStats'] = () => provider.stats;
