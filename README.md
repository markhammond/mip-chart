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
- **Prioritised request lanes** — the viewport and its two directional prefetch
  pads each ride a sticky, independently-conflated lane, so the visible range
  always paints first and a fast pan never blocks behind buffering
  ([details](#the-request-contract--lanes--priority)).
- **Synced multi-pane** — price + oscillators + state lanes share one time
  axis; pan/zoom in any pane mirrors the rest with no tearing.
- **Per-pane Y-autofit** — tracks the visible window, log-aware, OHLC-aware.
- **Gestures** — drag-pan, wheel-zoom about the cursor, double-click reset,
  shift-drag box zoom, velocity-projected prefetch.
- **Rendering** — constant-width candles (aggregated candles sit over the
  interval they summarise), shape-preserving (PCHIP) line curves,
  density-adaptive line width (thins toward a device-pixel hairline when zoomed
  out), causal hover values, UTC gridlines.
- **Span series** — `vrect` shaded time spans (sessions, event windows) and
  `vline` event lines, with line hatches, checkerboards and Excel's 18 fill
  patterns, styled labels, multi-pane extent, and optional line breaks across
  closed sessions ([details](#span-series--vrect--vline)).
- **Minimap** — full-extent overview scrubber driven purely by the time axis,
  with event marks that show from the first frame.
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

## The request contract — lanes & priority

The navigator never fires one bulk request. Each frame it splits the work across
three **sticky lanes** — the visible viewport plus two prefetch pads (ahead /
behind) — and calls `requestFrame` once per lane that's missing data. Each
`NavigationRequest` carries:

- **`laneId`** — a stable id per lane (the same three ids for the chart's life).
  Echo it back on every `SeriesFragment` so the navigator routes the response to
  the lane that asked.
- **`priority`** — `0` for the viewport (always first); the prefetch pads are
  `1`/`2`, assigned dynamically by travel direction (the pad you're panning
  toward outranks the trailing one). A backend draining a conflated priority
  queue paints the viewport first and buffers the pads behind it.
- **`phaseId`** — monotonic *within a lane*. A newer phase supersedes an
  in-flight one on the same lane; other lanes are untouched.
- **`sampleIntervalMs`** — the density the request was issued at; echo it back so
  fragments cache into the matching level-of-detail tier — even abandoned ones.

The contract is deliberately forgiving. A backend may **conflate** (keep only the
newest phase per lane, dropping superseded ones) and **load-shed** (stop
computing a superseded phase mid-flight and ship only what it finished, tagged
`cacheOnly`). The navigator caches every delivered fragment — committed, stale,
or cache-only — widening its tiers as you browse, and renders a phase only once
all of its fragments arrive (atomically, regardless of arrival order). Zero-row
fragments are left uncached so the range stays re-fetchable once data exists.

See `NavigationRequest` and `SeriesFragment` in [`src/types.ts`](./src/types.ts)
for the full field-by-field contract.

## Span series — `vrect` / `vline`

Shaded timespans and vertical lines are ordinary keyed series, fetched through
the same fragments. They never join the pane's unified timeline, so they don't
touch Y-autofit, percent mode or `trueExtrema`.

- `vrect`: `xs` are span starts (UTC ms); columns `[end, category?]`.
- `vline`: `xs` are line times; columns `[category?]`.
- Category defaults to 0 and indexes `categories` (fill, `hatch`, `edge`,
  `label`). Several categories ⇒ one legend item each, keyed `${key}#${ordinal}`.
- Return every span that **overlaps** the requested range. Eviction keeps spans
  that started earlier but still overlap the kept window.
- `panes: 'all' | string[]` draws across subplots; `layer: 'below' | 'above'`.
- `breaks: true` on a category stops line, band and state-bar series in the
  covered panes from connecting across (or drawing inside) those spans, once a
  span renders at least `breakMinPx` (default 3) wide.
- Hover adds a row per covering span / nearby vline via `hoverTemplate`
  (`{category}`, `{col.end:date:HH:mm}`); per-span text comes from
  `requestHoverDetail` with `{ seriesKey, x: spanStart }`. Over data, spans are
  read at the hovered sample, so a session row agrees with the bar shown; over a
  gap (a weekend) they are read at the cursor.

**Patterns.** `hatch.pattern` takes a drawn pattern — `diagonal`,
`back-diagonal`, `cross`, `diagonal-cross`, `horizontal`, `vertical`, `dots`,
`checker` — or one of Excel's fill patterns by its Office Open XML name:
`solid`, `darkGray` (75%), `mediumGray` (50%), `lightGray` (25%), `gray125`
(12.5%), `gray0625` (6.25%), `darkHorizontal`, `darkVertical`, `darkDown`,
`darkUp`, `darkGrid`, `darkTrellis`, `lightHorizontal`, `lightVertical`,
`lightDown`, `lightUp`, `lightGrid`, `lightTrellis` (bitmaps and Excel's menu
names in `EXCEL_PATTERNS`). `spacingPx` is the repeat period: line pitch, the
two-square period for `checker`, or the 8×8 bitmap's size for Excel patterns
(default 8, one CSS px per bitmap pixel). Patterns are anchored to time, so they
pan with the data.

**Labels.** `label: { text, position?, color?, fontSizePx?, fontWeight?,
minFontSizePx?, halo? }`. `\n` stacks lines. `color` defaults to the category's
ink; size and weight default to the legend entries' computed font. A label too
wide for its span shrinks to fit, down to `minFontSizePx` (default 10), and is
hidden below that. `halo: { color, widthPx? }` outlines the glyphs so text stays
legible over candles.

**Minimap marks.** `minimapOverlay: true` marks a series' events as they are
fetched. For marks that show from the first frame, pass them with the overview:
`navigator.acceptOverview(xs, values, [{ t, color }, …])` (`to` draws a bar).
They are kept in snapshots.

```ts
{ key: 'sessions', paneId: 'price', panes: 'all', label: 'Sessions', color: '#888',
  renderer: 'vrect', columns: ['end', 'category'],
  categories: [
    { name: 'Closed', fill: 'rgba(120,120,140,.08)', hatch: { pattern: 'diagonal' }, breaks: true },
    { name: 'Overnight', fill: 'rgba(120,120,140,.07)', breaks: true },
  ] }
```

See `examples/spans.html` (`npm run dev`, then open `/spans.html`).

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
