# mip-chart

> **Google Maps for time-series data.**

A framework-agnostic time-series charting library with **mipmap-style level of
detail**: like map tiles, it only ever fetches and draws the points the current
viewport can actually show. Pan and zoom across millions of samples — years of
high-frequency data — and the chart stays smooth because the data is streamed
and decimated to the screen, not loaded all at once.

Built on [uPlot](https://github.com/leeoniya/uPlot). No framework dependency —
hosts integrate through plain-JS callback hooks, so it drops into React, Vue,
Svelte, Blazor, or no framework at all.

## Why "mip"?

A [mipmap](https://en.wikipedia.org/wiki/Mipmap) is a precomputed pyramid of
progressively lower-detail versions of an image — the GPU samples whichever
level matches the screen. `mip-chart` does the same for time series: it keeps
per-density tiers and serves the one that matches your zoom, so the number of
points drawn stays roughly constant no matter how far you zoom out.

## Features

- **Virtual level of detail** — per-density tiers with on-demand fetch and
  eviction; only missing sub-ranges are requested, covered pans cost nothing.
- **Streaming + decimation** — designed around a fragment contract: the host
  returns viewport-sized, downsampled fragments (LTTB / OHLC-aggregate /
  transition-preserving). Out-of-order fragments commit atomically.
- **Synced multi-pane** — price + oscillators + state lanes share one time
  axis; pan/zoom in any pane mirrors the rest with no tearing.
- **Per-pane Y-autofit** — tracks the visible window, log-aware, OHLC-aware.
- **Gestures** — drag-pan, wheel-zoom about the cursor, double-click reset,
  shift-drag box zoom, velocity-projected prefetch.
- **Rendering** — constant-width candles, shape-preserving (PCHIP) line curves,
  causal hover values, UTC gridlines.
- **Minimap** — full-extent overview scrubber driven purely by the time axis.
- **Offline snapshot export** — serialize the current viewport to a
  self-contained HTML file that renders with no backend.

## Install

```sh
npm install mip-chart
```

## Quick start

```ts
import { ChartNavigator } from 'mip-chart';
import 'mip-chart/style.css';

const chart = new ChartNavigator(document.getElementById('chart'), {
  recipe,        // panes + series description (see ViewRecipe)
  extent,        // full time range of the data
  barMs,         // native sample cadence
  minimap: true,
  hooks: {
    // Called when the navigator needs data for a (range, density). Return
    // viewport-sized, downsampled fragments — this is where your server (or a
    // local decimator) does level-of-detail reduction.
    requestFrame: (req) => myProvider.load(req),
  },
});
```

See [`examples/`](./examples) for a complete, runnable host: a synthetic OHLC
provider (deterministic random walk, latency jitter, out-of-order delivery)
wired to the navigator exactly the way a real backend would be.

## Develop

```sh
npm install
npm run dev        # live example at http://localhost:8123
npm test           # vitest unit tests
npm run typecheck  # tsc --noEmit
npm run build      # bundle + type declarations into dist/
```

## License

[MIT](./LICENSE) © Mark Hammond
