// Core contracts for the virtual chart navigator.
// Host-agnostic: this package carries no host-framework symbols.

/** UTC milliseconds since epoch. The navigator's only time domain. */
export type UtcMillis = number;

/** Half-open interval [from, to) in UTC milliseconds. */
export interface TimeRange {
  from: UtcMillis;
  to: UtcMillis;
}

export type ScaleKind = 'linear' | 'log';

export type SeriesRenderer =
  | 'line'
  | 'candlestick'
  | 'band'
  | 'markers'
  | 'state' // stepped line over state ordinals
  | 'state-bars' // filled bars colored by ordinal
  | 'vrect' // shaded time spans (sessions, event windows)
  | 'vline'; // vertical lines at event times

/**
 * Excel's cell fill patterns, by their Office Open XML names (`patternFill
 * patternType`); Excel's Format Cells names in brackets. Each is Excel's 8×8
 * pixel bitmap.
 */
export type ExcelPattern =
  | 'solid' // Solid
  | 'darkGray' // 75% Gray
  | 'mediumGray' // 50% Gray
  | 'lightGray' // 25% Gray
  | 'gray125' // 12.5% Gray
  | 'gray0625' // 6.25% Gray
  | 'darkHorizontal' // Horizontal Stripe
  | 'darkVertical' // Vertical Stripe
  | 'darkDown' // Reverse Diagonal Stripe
  | 'darkUp' // Diagonal Stripe
  | 'darkGrid' // Diagonal Crosshatch
  | 'darkTrellis' // Thick Diagonal Crosshatch
  | 'lightHorizontal' // Thin Horizontal Stripe
  | 'lightVertical' // Thin Vertical Stripe
  | 'lightDown' // Thin Reverse Diagonal Stripe
  | 'lightUp' // Thin Diagonal Stripe
  | 'lightGrid' // Thin Horizontal Crosshatch
  | 'lightTrellis'; // Thin Diagonal Crosshatch

/** Hatch overlay for a span category: a drawn line pattern or one of Excel's fill patterns. */
export interface SpanHatch {
  pattern:
    | 'diagonal'
    | 'back-diagonal'
    | 'cross'
    | 'diagonal-cross'
    | 'horizontal'
    | 'vertical'
    | 'dots'
    | 'checker'
    | ExcelPattern;
  /** Hatch ink colour (default a translucent grey). */
  color?: string;
  /** Line pitch in CSS px (default 6); for 'checker', the repeat period of two
   *  squares; for an Excel pattern, the 8×8 bitmap's size (default 8, one CSS
   *  px per bitmap pixel). */
  spacingPx?: number;
  /** Line width (dot radius for 'dots') in CSS px (default 1). */
  widthPx?: number;
}

/** Style of one span/line category (vrect/vline `categories`, by ordinal). */
export interface SpanStyle {
  /** Category name: legend item and the `{category}` hover placeholder. */
  name: string;
  /** Span fill, any CSS colour incl. alpha. vline: line colour when `edge` is unset. */
  fill?: string;
  hatch?: SpanHatch;
  /** vrect: boundary lines. vline: the line itself. */
  edge?: {
    color: string;
    widthPx?: number;
    dash?: number[];
    /** vrect only (default 'both'). */
    sides?: 'both' | 'start' | 'end';
  };
  /** Static text drawn once, in the topmost visible pane the series covers.
   *  `\n` stacks lines; `color` defaults to the category's ink (its edge,
   *  hatch or fill colour without alpha); `fontSizePx` and `fontWeight` default
   *  to the legend entries' font. `halo` outlines the glyphs so text stays
   *  legible over data; its width is what shows outside them (CSS px, default 1).
   *  A label too wide for its span shrinks to fit, down to `minFontSizePx`
   *  (default 10), and is hidden below that. */
  label?: {
    text: string;
    position?: 'top-left' | 'top' | 'inside';
    color?: string;
    fontSizePx?: number;
    fontWeight?: number | string;
    minFontSizePx?: number;
    halo?: { color: string; widthPx?: number };
  };
  /** vrect only: line, band and state-bar series in the covered panes don't
   *  connect across (or draw inside) these spans. */
  breaks?: boolean;
  /** Minimum rendered span width (CSS px) at which `breaks` applies, so wide
   *  zooms stay continuous (default 3). */
  breakMinPx?: number;
}

/** One vertically stacked subplot sharing the unified X (time) axis. */
export interface PaneDef {
  id: string;
  /** Relative height weight within the stack. */
  heightWeight: number;
  scale: ScaleKind;
  /** Categorical state lane: ordinal → label, index 0 reserved "Undefined". */
  stateNames?: string[];
  /** Ordinal → fill color for the 'state-bars' renderer (default viridis-ish). */
  stateColors?: string[];
  /** Optional axis title. */
  title?: string;
  /**
   * Y-axis tick label format (hoverFormat.ts FMT, e.g. '.2bp' for basis
   * points) — gives the pane explicit units, matching its hover templates.
   * Default: native compact formatting.
   */
  axisFormat?: string;
  /**
   * Y-axis tick-label visibility for this pane. 'hide' blanks the labels
   * (the gutter is kept so panes stay horizontally aligned) — useful to
   * declutter a dense state lane. Default 'show'.
   */
  axisLabels?: 'show' | 'hide';
  /**
   * Slant the Y-axis labels by this many degrees (negative tilts up toward the
   * gutter). uPlot can't rotate Y labels, so the pane draws them itself: longer
   * category names show before truncation, and overlapping rows auto-thin.
   * Unset/0 ⇒ horizontal. Ignored when axisLabels is 'hide'.
   */
  axisLabelAngle?: number;
}

/** A keyed series — no positional contracts. */
export interface SeriesDef {
  key: string;
  paneId: string;
  label: string;
  /** Legend group for grouped toggles. */
  group?: string;
  color: string;
  renderer: SeriesRenderer;
  /**
   * Column names this series consumes from its fragments, in renderer-defined roles:
   *  line/markers/state: [value]
   *  candlestick:        [open, high, low, close]
   *  band:               [upper, lower]
   *  vrect:              [end, category?] — xs are span starts, `end` is UTC ms
   *  vline:              [category?]      — xs are line times
   * Span/line category defaults to 0. Providers return every span that
   * OVERLAPS the requested range (a span may start before `range.from`). The
   * wire format stays numeric; per-span text comes via requestHoverDetail.
   */
  columns: string[];
  /** vrect/vline: panes to draw in (default `[paneId]`); `paneId` stays the
   *  home pane for legend ordering. */
  panes?: string[] | 'all';
  /** vrect/vline: 'below' draws over the grid but under the series (default);
   *  'above' draws over everything. */
  layer?: 'below' | 'above';
  /** vrect/vline: category ordinal → style. One legend item per category when
   *  there are several (keyed `${key}#${ordinal}`). */
  categories?: SpanStyle[];
  /** vrect: spans narrower than this (CSS px) at the current zoom are dropped;
   *  same-category spans closer than 1px merge (default 1). */
  minWidthPx?: number;
  /** Designated percentage-mode baseline. At most one per pane. */
  baseline?: boolean;
  /**
   * Which of `columns` carries the baseline value (defaults to columns[0]).
   * E.g. a candlestick baseline anchors to 'close'.
   */
  baselineColumn?: string;
  /** Initially hidden in the legend. */
  hidden?: boolean;
  /** Drop from BOTH legends (strip + hover) while still drawing it — a
   *  non-interactive visual overlay (e.g. the undefined-factor sentinel). */
  excludeFromLegend?: boolean;
  /** Mirror this (sparse) series onto the minimap as coloured dots, accumulated
   *  as ranges are fetched — an at-a-glance marker for rare events. */
  minimapOverlay?: boolean;
  /** Line renderer: draw as a step function (e.g. a value that holds between
   *  sparse updates). */
  step?: boolean;
  /** Line renderer curve: shape-preserving PCHIP cubic by default (smooth, no
   *  overshoot); 'linear' opts a series back to straight segments. */
  curve?: 'monotone' | 'linear';
  /**
   * Line renderer: draw a marker circle at every (non-null) sample — a
   * line+markers combo for a sparse event series (discrete event values +
   * a held step line through the gaps). `color` styles the markers/legend;
   * `lineColor` styles the line.
   */
  showPoints?: boolean;
  /** Marker diameter for showPoints (CSS px, default 6). Overlaid series
   *  use staggered sizes so both colors stay visible. */
  pointSizePx?: number;
  /** Line stroke override when it should differ from the marker/legend
   *  color (e.g. a faint gray held line under colored markers). */
  lineColor?: string;
  /** Stroke width (CSS px) for line/band edges. 0 ⇒ no line drawn — for a
   *  band that means a fill-only lane (hover dots still use `color`).
   *  Defaults: line 1.25, state 2, band 1. */
  lineWidthPx?: number;
  /**
   * Recipe-defined hover label template (hoverFormat.ts — a typed,
   * injection-free subset of the Plotly-style hovertemplate convention).
   * Placeholders: {label},
   * {value[:FMT]}, {col.NAME[:FMT]}, {col.NAME:date:PATTERN}, {x[:date:PATTERN]},
   * {state}, {category};
   * FMT = .Nf | .Ns | .N%; '\n' adds indented rows. Defaults: lines show
   * 'label: value'; candles show a compact O/H/L/C row; vrect/vline show
   * 'label: category'.
   */
  hoverTemplate?: string;
  /**
   * Recipe-defined point actions: typed, no free-form HTML.
   * Clicking a point on this series dispatches hooks.onPointAction.
   */
  actions?: PointAction[];
}

/** Declarative engine-agnostic view recipe. */
export interface ViewRecipe {
  id: string;
  panes: PaneDef[];
  series: SeriesDef[];
  /** Plot-pane background fill (each subplot panel). Unset ⇒ transparent. */
  background?: string;
  /** Minimap panel background. Unset ⇒ transparent (shows through to the page
   *  / chart background); set it to extend the chart theme over the minimap. */
  minimapBackground?: string;
  /** Gridline colour, shared across panes AND the minimap data-shadow line —
   *  a frugal single grey. Unset ⇒ uPlot default grid / built-in minimap line. */
  gridColor?: string;
  /** Minimap data-shadow AREA fill. Unset ⇒ the built-in faint shadow. */
  minimapFill?: string;
  /** Horizontal plot inset (em) reserving edge room so x-axis labels don't
   *  clip as they scroll in/out at the left/right edges. Unset ⇒ 0. */
  chartInsetEm?: number;
  /** Corner radius (em) for the chart area. Unset ⇒ square. */
  cornerRadiusEm?: number;
  /** Pane-title font weight (CSS numeric, e.g. 500 = medium). Unset ⇒ uPlot's
   *  bold default. Applies to every pane title. */
  titleWeight?: number;
  /** Faint centred watermark for the PRIMARY pane (e.g. a label describing the
   *  series). Auto-wraps and auto-scales to fill the plot; no manual
   *  line breaks. Unset ⇒ none. */
  watermark?: string;
}

/**
 * One series' data for one phase. Fragments stream in parallel and may arrive
 * out of order; the phase commits when `fragmentCount` fragments with the same
 * `(laneId, phaseId)` have arrived (phase barrier). Phases on different
 * lanes are independent — each lane commits on its own.
 */
export interface SeriesFragment {
  /** The request lane this fragment answers — routes it to the matching
   *  coordinator lane (echoed from NavigationRequest.laneId). */
  laneId: string;
  /** The request's density (echoed from NavigationRequest.sampleIntervalMs) —
   *  routes the fragment to the matching density tier in the cache, so a stale
   *  or cache-only fragment is still cached at the correct resolution. */
  sampleIntervalMs: number;
  /** When true, this is a salvaged partial from a superseded build: cache it,
   *  but never feed it to the phase barrier (no render/commit). */
  cacheOnly?: boolean;
  /** Monotonic WITHIN the lane. A higher phaseId supersedes an incomplete
   *  prior phase on the SAME lane; other lanes are unaffected. */
  phaseId: number;
  /** Total fragments in this phase (same value on every fragment of the phase). */
  fragmentCount: number;
  seriesKey: string;
  /** Coverage of this fragment (may exceed [xs[0], xs[last]] when sparse). */
  range: TimeRange;
  /** Sorted ascending, UTC ms. */
  xs: UtcMillis[];
  /** Column name → values, each aligned 1:1 with xs. */
  columns: Record<string, Array<number | null>>;
  /**
   * True full-resolution extrema of this series inside the *visible* range,
   * computed by the provider before downsampling. Null when the
   * fragment is full-resolution.
   */
  trueExtrema?: { min: number; max: number } | null;
  /**
   * True full-resolution left-edge baseline value for the visible range
   * (only meaningful on the recipe's baseline series).
   */
  trueBaseline?: number | null;
}

/** What the navigator asks the host for when a navigation gesture settles.
 *  Emitted per LANE: the viewport and each prefetch pad ride their own
 *  lane so the host can prioritise + conflate them independently. */
export interface NavigationRequest {
  /**
   * Stable id for this request's lane (a GUID minted per navigator). The
   * host treats it opaquely: conflate by it (a newer request for the same
   * lane supersedes a queued one — no backlog) and route the answer's
   * fragments back tagged with it.
   */
  laneId: string;
  /**
   * Scheduling priority — LOWER is served first. Dynamic: the viewport is
   * always 0; the prefetch pad in the direction of travel outranks the trailing
   * one. The host orders work by this; it does NOT identify the lane.
   */
  priority: number;
  /** Monotonic WITHIN this lane (the host echoes it onto fragments). */
  phaseId: number;
  visible: TimeRange;
  /**
   * The not-yet-loaded sub-ranges to fetch for THIS lane (the lane's
   * span minus the loaded-range set). May be empty (then no request is sent).
   * The provider serves these at the requested density.
   */
  fetchRanges: TimeRange[];
  /** Device-independent plot width, for the provider's point budget. */
  widthPx: number;
  /** Point budget per series derived from widthPx × pointsPerPx. */
  maxPointsPerSeries: number;
  /**
   * Desired sampling interval (ms per shipped point), derived from viewport
   * density (plot width × points-per-px over the visible span). The provider
   * quantizes to this grid; maxPointsPerSeries stays as the budget fallback.
   */
  sampleIntervalMs: number;
}

/** Stable point identity. */
export interface PointRef {
  seriesKey: string;
  x: UtcMillis;
}

/** Recipe-defined point action — typed, no free-form HTML. */
export interface PointAction {
  id: string;
  label: string;
}

/** Overview (minimap) data request — separate from main-frame phases. */
export interface OverviewRequest {
  /** Point budget for the full-extent orientation series. */
  maxPoints: number;
}

/**
 * A full-extent minimap mark the host supplies with the overview: a dot at `t`,
 * or a bar from `t` to `to`. Unlike `minimapOverlay` series, which mark only
 * what has been fetched, these show from the first frame.
 */
export interface MinimapMark {
  t: UtcMillis;
  to?: UtcMillis | null;
  color: string;
}

/**
 * The host boundary. The host application (e.g. a framework binding or test
 * harness) supplies these plain-JS callbacks; the library never imports host
 * code.
 */
export interface NavigatorHooks {
  /**
   * A navigation frame needs data. The host fetches (range, density) and feeds
   * fragments back via ChartNavigator.acceptFragment. Fire-and-forget; the
   * phase barrier handles ordering/supersession.
   */
  requestFrame(req: NavigationRequest): void;
  /**
   * The minimap wants a full-extent overview series (refined detail).
   * The host responds via ChartNavigator.acceptOverview, optionally with
   * full-extent marks. Optional — without it the minimap shows only the
   * coarse sketch from loaded data.
   */
  requestOverview?(req: OverviewRequest): void;
  /** Lazy hover detail. Resolve to plain text lines, or null for none. */
  requestHoverDetail?(ref: PointRef, signal: AbortSignal): Promise<string | null>;
  /** A recipe-defined point action was invoked. */
  onPointAction?(actionId: string, ref: PointRef): void;
  /** The shared time axis moved (gesture/navigate/brush) — host state sync. */
  onVisibleChange?(range: TimeRange, cause: string): void;
  /** Loading/error surface. */
  onStatus?(status: 'idle' | 'loading' | 'error', detail?: string): void;
}

/**
 * A frozen viewport: everything needed to re-render the current chart offline,
 * with no backend. Serialized into a self-contained HTML file (snapshot.ts).
 * Navigation in a snapshot is constrained to the captured data.
 */
export interface ChartSnapshot {
  v: 1;
  recipe: ViewRecipe;
  barMs: number;
  extent: TimeRange;
  visible: TimeRange;
  percentMode: boolean;
  /** Series keys hidden via the legend at capture time. */
  hidden: string[];
  /** Per-series columnar data currently in memory (covers the viewport). */
  stores: Array<{ key: string; xs: number[]; columns: Record<string, Array<number | null>> }>;
  /** Minimap full-extent overview, if one was loaded. */
  overview: { xs: number[]; values: Array<number | null>; marks?: MinimapMark[] } | null;
}

export interface NavigatorOptions {
  /** A frozen snapshot — when set, the chart renders offline from it (no fetch
   *  hooks fire). The generated bootstrap also passes recipe/extent/barMs from
   *  the snapshot, so they stay populated. */
  snapshot?: ChartSnapshot;
  recipe: ViewRecipe;
  hooks: NavigatorHooks;
  /** Full navigable extent, known up front. */
  extent: TimeRange;
  /** Initial visible window (defaults to the snapshot's captured window, else
   *  the most recent `initialBars`·barMs). */
  initialVisible?: TimeRange;
  /** Nominal bar duration, used for candle width + gesture step heuristics. */
  barMs: number;
  /** Gesture-settle debounce in ms (default 200). */
  settleMs?: number;
  /** Point budget per CSS pixel (default 2). */
  pointsPerPx?: number;
  /** Floor for density-adaptive line thinning, in DEVICE pixels (default 1 — a
   *  crisp hairline). Converted to CSS px via devicePixelRatio at draw time, so
   *  it stays a fixed physical width on any display. The host owns this
   *  device-capability / perception judgment; the library only tapers toward it. */
  minLineWidthDevicePx?: number;
  /** Source bars/px at which the adaptive line width reaches its floor (default
   *  100). The line tapers base→floor linearly in log10(density) up to here, so a
   *  higher value = gentler taper. The other half of the (subjective) line-width
   *  calibration the host owns, alongside minLineWidthDevicePx. */
  lineWidthDensityFloor?: number;
  /** @deprecated symmetric margin; superseded by scaleMargins. */
  yMarginFrac?: number;
  /** Lightweight-charts price scale margins (fractions of pane height kept
   *  empty above/below the data). Defaults: top 0.2, bottom 0.1. */
  scaleMargins?: { top?: number; bottom?: number };
  /** Overview minimap strip. Default on; false disables. */
  minimap?: boolean | { heightPx?: number };
  /**
   * Maximum zoom-in magnification (perception-based, see timeAxis.ts
   * minVisibleSpanMs): one bar may not exceed maxBarPitchPx (full candle
   * articulation, default 16), and at least minVisibleBars stay in view
   * (structural-context floor, default 48).
   */
  zoomClamp?: { maxBarPitchPx?: number; minVisibleBars?: number };
  /**
   * Number of lines the host's hover detail will occupy. The tooltip
   * reserves them up front (placeholder dots) so it never resizes when the
   * lazy detail arrives.
   */
  hoverDetailLines?: number;
  /** Y-axis side per pane stack ('right' places values on the right, the
   *  lightweight-charts convention). */
  yAxisSide?: 'left' | 'right';
  /** Minimal theme tokens (colors are otherwise host CSS concerns). */
  theme?: {
    /** Axis tick/label color. */
    axis?: string;
    /** Gridline color. */
    grid?: string;
    /** Primary pane axis tick font size (default 12). */
    axisFontPx?: number;
    /** Secondary panes use a tiny crisp monospace (default 9px Menlo) so
     *  their Y labels stay readable without stealing plot space. */
    subAxisFontPx?: number;
  };
}
