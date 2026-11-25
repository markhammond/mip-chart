// ChartNavigator — the host-agnostic composition root.
// A shared TimeAxis is the loose-coupling spine: pane stack, gesture plugins,
// minimap, and host all attach to it without referencing each other. The
// navigator owns the navigation-frame lifecycle (settle debounce → fetch plan →
// phase barrier → atomic commit) plus Y-autofit, % origin, loaded-range set and
// eviction.

import uPlot from 'uplot';
import type {
  ChartSnapshot,
  MinimapMark,
  NavigatorHooks,
  NavigatorOptions,
  NavigationRequest,
  PointRef,
  SeriesDef,
  SeriesFragment,
  TimeRange,
  UtcMillis,
} from './types';
import { TimeAxis, minVisibleSpanMs, type NavigationCause } from './timeAxis';
import { FrameCoordinator } from './frameCoordinator';
import { DisjointIntervalSet } from './intervals';
import { SeriesStore, alignStores, priorNonNullIdx } from './seriesStore';
import { ExtentAccumulator, fitY } from './autofit';
import { PercentOrigin } from './percentAxis';
import { candlestickPlugin, hiddenScaleSeries } from './candles';
import { pchipPaths } from './paths';
import { gesturePlugin } from './gestures';
import { Minimap } from './minimap';
import { tvLinearTicks, tvLogTicks, tvPercentTicks } from './splits';
import { tvTimeTicks } from './timeTicks';
import {
  formatHoverDate,
  formatHoverNumber,
  renderHoverTemplate,
  type HoverContext,
} from './hoverFormat';
import { LegendModel } from './legendModel';
import { LegendStrip } from './legend';
import { stateBarsPlugin } from './stateBars';
import { DateRangePicker } from './dateRangePicker';
import { angledAxisLabels } from './axisLabels';
import { makeWatermark } from './watermark';
import {
  VLINE_HOVER_PX,
  breakGapsPx,
  breakIntervals,
  hasBreakingCategory,
  isSpanRenderer,
  linesNear,
  spanColumns,
  spanInkColor,
  spanPaneIds,
  spanSwatchCss,
  spansAt,
  spanHoverTime,
  DEFAULT_LABEL_FONT,
  type LabelFont,
  spansInRange,
  spansPlugin,
  subtractIntervals,
  unionIntervals,
  type Interval,
} from './spans';

/** A per-density tier (#2): all series' stores + the loaded-range set, at one
 *  zoom band's density. Switching tiers swaps the displayed data wholesale, so
 *  a density change reuses a cached band instead of nuking everything. */
interface Tier {
  stores: Map<string, SeriesStore>;
  loaded: DisjointIntervalSet;
}

/** Max simultaneously-cached density tiers (bounded LRU). */
const MAX_TIERS = 6;

interface PaneRuntime {
  id: string;
  el: HTMLElement;
  plot: uPlot;
  /** (def, column) feeding each uPlot series slot >= 1, in slot order. The
   *  backing store is looked up on the ACTIVE tier (it changes per density). */
  slots: Array<{ def: SeriesDef; column: string }>;
  log: boolean;
  isStateLane: boolean;
  yRange: [number, number];
  percent: PercentOrigin | null; // set on the baseline-series pane
  /** Y-axis drag-zoom override: autofit is suspended until the user
   *  double-clicks the axis or a new frame commits. */
  manualY: boolean;
  /** Plain line series (uPlot index + recipe base width) eligible for
   *  density-adaptive thinning when zoomed out. */
  adaptiveLines: Array<{ idx: number; base: number }>;
  /** Label lookup for the TVLC time ticks of the latest axes calc. */
  timeTickLabels?: Map<number, string>;
  /** vrect/vline series drawn in this pane. */
  spanDefs: SeriesDef[];
}

const PREFETCH_FRAC = 0.75; // base padding each side of the viewport
const EVICT_FACTOR = 6; // keep ≤ EVICT_FACTOR × viewport span in memory
// Source bars/px at which an adaptive line reaches its width floor. Width tapers
// base→floor linearly in log10(density) up to here (gentle, not a fast drop-off).
// Calibrated so a 1-year 30m view (~21 bars/px on a ~800px plot) lands near
// 0.75px on a retina display (base 1.25, floor 0.5).
const DENSITY_FLOOR_BARS_PER_PX = 100;
// Explicit x-axis size for the bottom-most VISIBLE pane so the shared time
// labels follow it as panes hide/show (a literal avoids the `size: undefined`
// default-clobber footgun).
const X_AXIS_LABEL_PX = 25;
// uPlot calls axis.size() as a function — stable references for the bottom
// (label-bearing) pane vs. the collapsed x-axis of every other pane.
const bottomAxisSize = (): number => X_AXIS_LABEL_PX;
const zeroAxisSize = (): number => 0;

// Velocity-projected lookahead: pan velocity decays ~exponentially after release,
// so the inertial stopping distance ≈ v₀·τ is the "one swipe worth" to load
// ahead. v is measured live (data-ms per wall-ms); scales with swipe strength
// and is frame-rate independent.
const INERTIA_TAU_MS = 325; // fling time-constant — the v·τ projection horizon
const VELOCITY_EWMA = 0.45; // smoothing of the instantaneous velocity sample
const VELOCITY_GAP_RESET_MS = 120; // a gap this long means the gesture ended
// Clamp the projected lead: slow drag gets a floor, hard fling never requests an
// unbounded strip. Kept < EVICT_FACTOR so prefetched data survives.
const LEAD_MIN_FRAC = 0.5; // interim-fetch trigger: only refill mid-fling above this
const LEAD_MAX_FRAC = 3.0; // ≤ 3 viewports ahead on the hardest fling
const INTERIM_MIN_GAP_MS = 120; // throttle pre-settle refills during a fling
// Prefetch lead FLOOR as a physical distance, max'd with the velocity
// projection. 30 CSS-cm ≈ one chart width, zoom-independent. CSS: 1cm = 96/2.54 px.
const PREFETCH_FLOOR_CM = 30;
const CSS_PX_PER_CM = 96 / 2.54;
/** One Y-gutter width for EVERY pane and the minimap — uniform gutters are
 *  what keep the stacked plot areas pixel-aligned. */
const AXIS_GUTTER_PX = 70;
/** Symmetric vertical breathing room: the gap above the first
 *  pane's title equals the gap below the bottom x-axis (above the range
 *  readout). Applied as a margin on both ends and reserved in the height calc. */
const CHART_V_GAP = 10;
/** Inset INSIDE the chart panel above the topmost plot, so whichever pane is
 *  on top always gets breathing room (panes themselves butt together for
 *  contiguous gridlines, so this lives on the panel, not the pane). */
const TOP_INSET_PX = 8;
/** Gap above a subplot title: pushes it down toward its own plot and away from
 *  the chart above. The first pane's gap comes from paneStack. */
const SUBPLOT_TITLE_TOP_GAP = 10;

export class ChartNavigator {
  /** The shared time axis — public extension point for axis-linked components. */
  readonly axis: TimeAxis;

  private readonly opts: Required<Pick<NavigatorOptions, 'settleMs' | 'pointsPerPx'>> &
    NavigatorOptions;
  private readonly coordinator: FrameCoordinator;
  /** Sticky per-lane request ids: the viewport and the two prefetch pads
   *  each ride a STABLE lane so the backend conflates + prioritises per
   *  lane. The id is stable; the priority is dynamic (assigned per request).
   *  Routed back via SeriesFragment.laneId to the matching coordinator lane. */
  private readonly visibleLane = crypto.randomUUID();
  private readonly aheadLane = crypto.randomUUID();
  private readonly behindLane = crypto.randomUUID();
  /** Viewport `from` of the in-flight visible request, promoted to
   *  `lastReceivedVisibleFrom` when that request commits — drives the
   *  travel-direction prefetch priority. */
  private visibleRequestFrom = 0;
  private lastReceivedVisibleFrom: number | null = null;
  /** Did the CURRENT frame's request include a viewport fetch? When false (the
   *  cache already covered the viewport), a background prefetch must not grey the
   *  crisp viewport — it fills its pads silently. Gates the prefetch-coherence
   *  arm of the skeleton so it only applies to a genuine viewport load. */
  private frameHasVisibleFetch = false;
  /** Per-density tier cache (#2): one tier per power-of-2 line-bucket band, so
   *  a density change (zoom/preset) switches tiers instead of clearing the
   *  cache — revisiting a band re-renders from its tier with no re-fetch. */
  private readonly tiers = new Map<string, Tier>();
  private activeTier: Tier;
  /** MRU tier keys (front = newest) for the bounded-tier LRU. */
  private readonly tierLru: string[] = [];
  /** `${laneId}:${phaseId}` → the tier its request was emitted for. Lets a
   *  delivered fragment (committed, stale, or cache-only) cache into the exact
   *  tier it was fetched for — without echoing the tier on the wire. Bounded
   *  insertion-order map (oldest evicted); a fragment whose phase has aged out
   *  simply isn't cached (its data is long superseded). */
  private readonly phaseTier = new Map<string, Tier>();
  /** Cached: does the recipe draw candlesticks? (Gates candle-band tiering.) */
  private readonly hasCandles: boolean;
  private readonly panes: PaneRuntime[] = [];
  private minimap: Minimap | null = null;
  private datePicker: DateRangePicker | null = null;
  private overviewLoaded = false;
  /** Last full-extent overview fed to the minimap — captured for snapshots. */
  private lastOverview: { xs: UtcMillis[]; values: Array<number | null>; marks?: MinimapMark[] } | null = null;
  /** Host-supplied full-extent minimap marks (acceptOverview). */
  private overviewMarks: MinimapMark[] = [];
  /** Recipe-flagged minimap-overlay series → accumulated event timestamps,
   *  widened incrementally as ranges arrive (an at-a-glance error marker). */
  private readonly minimapOverlays = new Map<
    string,
    { column: string; color: string; ts: Set<UtcMillis> }
  >();
  /** minimapOverlay vrect/vline series → accumulated start → { end, colour }. */
  private readonly minimapSpanOverlays = new Map<
    string,
    Map<UtcMillis, { to?: UtcMillis; color: string }>
  >();
  /** vrect/vline series — drawn by spansPlugin, never uPlot series. */
  private spanDefs: SeriesDef[] = [];
  /** Hidden span series (`key`) or categories (`key#ordinal`). */
  private readonly hiddenSpans = new Set<string>();
  /** Bumped when span data or visibility changes (invalidates breakCache). */
  private spanVersion = 0;
  private readonly breakCache = new Map<string, { sig: string; breaks: Interval[] }>();
  /** Last pointer position over a pane (CSS px from the plot's left edge),
   *  unsnapped — span/vline hover needs the true cursor time. */
  private rawPointer: { u: uPlot; left: number } | null = null;

  // The active tier's state, surfaced as the navigator's "current" data so the
  // fetch/render/hover paths stay tier-agnostic (most call sites unchanged).
  private get stores(): Map<string, SeriesStore> {
    return this.activeTier.stores;
  }
  private get loaded(): DisjointIntervalSet {
    return this.activeTier.loaded;
  }
  // --- velocity-projected prefetch state (sampled from the live axis) ---
  /** Previous live range + wall-clock, to difference into a content velocity. */
  private prevLiveRange: TimeRange | null = null;
  private prevLiveMs = 0;
  /** Signed EWMA of content velocity (data-ms per wall-ms); ~live pan speed. */
  private panVelocity = 0;
  /** Peak |velocity| within the current fling and its direction — the settle
   *  projection uses the peak, not the decayed tail, so we prefetch a whole
   *  swipe ahead rather than just the dying coast. */
  private flingPeak = 0;
  private flingDir = 0;
  /** Last wall-clock an interim (pre-settle) refill fired — throttle gate. */
  private lastInterimMs = 0;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private percentMode = false;
  private destroyed = false;
  private hoverAbort: AbortController | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverX: number | null = null;
  /** Identity of the rendered hover (x + span refs), for superseding fetches. */
  private hoverSig = '';
  private hoverPos: { pane: PaneRuntime; left: number; top: number } | null = null;
  /** True while a continuous gesture (pan/box/pinch/axis-drag) is active —
   *  the hover label hides for the duration. */
  private gestureActive = false;
  /** Box-zoom undo stack (push on box zoom, pop on double-tap/double-click). */
  private readonly zoomStack: TimeRange[] = [];
  /** Long-press hover-legend state: 'live' = follow cursor (default),
   *  'hidden' = suppressed (trackpad toggle), 'pinned' = fixed at a point
   *  (touch toggle, where there is no live hover). */
  private hoverState: 'live' | 'hidden' | 'pinned' = 'live';
  /** Per-point lazy-detail cache (FIFO-capped) — revisits render instantly. */
  private readonly detailCache = new Map<string, string>();
  private tooltip: HTMLElement;
  private statusChip: HTMLElement;
  /** Chart title heading, rendered OUTSIDE the chart area (above it). */
  private chartTitleEl: HTMLElement | null = null;
  /** Visible-range readout strip (container) below the shared x-axis. */
  private rangeLabel: HTMLElement | null = null;
  /** The interactive readout pill inside it (the date-picker trigger). */
  private rangeText: HTMLElement | null = null;
  private legendModel: LegendModel | null = null;
  private legendStrip: LegendStrip | null = null;
  /** Legend entries' font, read once the strip is laid out (span label default). */
  private legendFont: LabelFont | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeRaf = 0;
  /** Frozen snapshot (offline): one captured tier, no backend. Suppresses
   *  resolution-dependent re-fetching and the skeleton greyscale (a resize
   *  would otherwise tier-switch into an empty, un-fetchable tier). */
  private frozen = false;
  // Subplot auto-hide: a pane with NO visible series collapses entirely
  // (plot + its uPlot title, which lives inside the pane container). The
  // shared x-axis labels follow the bottom-most still-visible pane.
  private readonly hiddenPanes = new Set<string>();
  private relayoutRaf = 0;
  private bottomVisiblePid = '';
  private paneStack: HTMLElement;
  private minimapEl: HTMLElement | null = null;

  constructor(private readonly root: HTMLElement, options: NavigatorOptions) {
    this.opts = { settleMs: 200, pointsPerPx: 2, ...options };
    const initialVisible =
      options.initialVisible ??
      options.snapshot?.visible ?? // a snapshot reopens at the window it captured
      { from: options.extent.to - 1000 * options.barMs, to: options.extent.to };

    this.axis = new TimeAxis(options.extent, initialVisible);
    this.updateZoomClamp();
    this.coordinator = new FrameCoordinator((laneId, phaseId, frags) =>
      this.commitPhase(laneId, phaseId, frags),
    );

    this.hasCandles = this.opts.recipe.series.some((s) => s.renderer === 'candlestick');
    this.spanDefs = this.opts.recipe.series.filter((s) => isSpanRenderer(s.renderer));

    // Seed the active tier (replaced by the band-keyed tier on first nav).
    this.activeTier = this.makeTier();

    // Unified frosted-glass hover label with per-series color bullets.
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'vcn-tooltip';
    this.tooltip.style.cssText =
      'position:absolute;pointer-events:none;display:none;z-index:10;' +
      'background:rgba(255,255,255,.62);backdrop-filter:blur(9px) saturate(1.4);' +
      '-webkit-backdrop-filter:blur(9px) saturate(1.4);' +
      'border:1px solid rgba(0,0,0,.08);box-shadow:0 4px 16px rgba(0,0,0,.12);' +
      'color:#1c1c28;font:12px/1.45 system-ui,sans-serif;' +
      'font-variant-numeric:tabular-nums;padding:7px 10px;border-radius:8px;' +
      'white-space:pre;min-width:22ch;';
    root.style.position = 'relative';
    root.appendChild(this.tooltip);

    // In-flight / error indicator owned by the library.
    this.statusChip = document.createElement('div');
    this.statusChip.className = 'vcn-status';
    this.statusChip.style.cssText =
      'position:absolute;top:4px;right:8px;z-index:11;display:none;' +
      'font:11px system-ui,sans-serif;padding:2px 8px;border-radius:10px;';
    root.appendChild(this.statusChip);

    // Chart title as a heading ABOVE the chart area, not a uPlot pane title.
    const titleText = this.opts.recipe.panes[0]?.title;
    if (titleText) {
      this.chartTitleEl = document.createElement('div');
      this.chartTitleEl.style.cssText =
        'text-align:center;font:18px system-ui,-apple-system,sans-serif;' +
        `font-weight:${this.opts.recipe.titleWeight ?? 700};color:#1f2733;padding:2px 0 6px;`;
      this.chartTitleEl.textContent = titleText;
      root.appendChild(this.chartTitleEl);
    }

    this.buildLegend();
    this.paneStack = document.createElement('div');
    // Smooth the skeleton greyscale ↔ colour transition (updateSkeletonState).
    this.paneStack.style.transition = 'filter 180ms ease';
    // Top inset INSIDE the panel so whichever pane is topmost (the first may be
    // hidden) gets breathing room while panes still butt together.
    this.paneStack.style.paddingTop = `${TOP_INSET_PX}px`;
    // Rounded chart area (recipe): clip the stacked panes to the radius.
    const radiusEm = this.opts.recipe.cornerRadiusEm;
    if (radiusEm) {
      this.paneStack.style.borderRadius = `${this.emPx(radiusEm)}px`;
      this.paneStack.style.overflow = 'hidden';
    }
    // Panel background on the chart area so the range readout inside it reads
    // as part of the chart.
    if (this.opts.recipe.background) this.paneStack.style.background = this.opts.recipe.background;
    root.appendChild(this.paneStack);

    this.buildPanes();

    // Visible-range readout strip between the shared x-axis and the minimap;
    // populated immediately so it's never blank at startup.
    this.rangeLabel = document.createElement('div');
    // Container only centres; the pill carries styling + hover affordance.
    this.rangeLabel.style.cssText =
      `text-align:center;padding:${CHART_V_GAP}px 0;transition:filter 180ms ease;`;
    // Pill that reads as a control (calendar glyph + caret); clicking opens the
    // date-range picker.
    const trigger = document.createElement('span');
    trigger.className = 'vcn-range-trigger';
    trigger.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" ' +
      'stroke="currentColor" stroke-width="1.4" stroke-linecap="round">' +
      '<rect x="2" y="3" width="12" height="11" rx="1.6"/>' +
      '<path d="M2 6.6h12M5.6 1.6v2.4M10.4 1.6v2.4"/></svg>' +
      '<span class="vcn-rt-text"></span>';
    this.rangeText = trigger.querySelector('.vcn-rt-text');
    this.rangeLabel.appendChild(trigger);
    // Inside the chart area (within the rounded panel), below the x-axis.
    this.paneStack.appendChild(this.rangeLabel);
    // Legend below the chart area (above the minimap); the top carries only the
    // title.
    if (this.legendStrip) root.appendChild(this.legendStrip.el);
    this.updateRangeLabel(this.axis.visible);

    // The readout pill doubles as the date-range trigger: a dual-month picker
    // that sets the visible window. Self-contained, so it works in snapshots too.
    this.datePicker = new DateRangePicker(trigger, {
      getVisible: () => this.axis.visible,
      getExtent: () => ({ ...this.axis.extent }),
      onApply: (r) => this.navigateTo(r),
    });

    this.buildMinimap();

    // The navigator itself is just another axis subscriber.
    this.axis.subscribe((range, cause) => this.onAxisChange(range, cause));

    // Track host-driven size changes (sidebar collapse, window resize).
    this.resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = requestAnimationFrame(() => this.resize());
    });
    this.resizeObserver.observe(root);

    if (options.snapshot) {
      // Frozen viewport (offline): render from captured data, no fetch.
      this.frozen = true;
      this.loadSnapshot(options.snapshot);
    } else {
      this.requestNavigation(this.axis.visible, true);
      this.requestOverview();
    }
  }

  // ------------------------------------------------------------------ build

  /** Plot width = the pane stack's content box (excludes root padding). */
  private plotWidth(): number {
    return this.paneStack?.clientWidth || this.root.clientWidth || 1200;
  }

  private paneStackHeight(): number {
    const total = this.root.clientHeight || 720;
    const legendH = this.legendStrip ? this.legendStrip.el.offsetHeight || 28 : 0;
    const rangeH = this.rangeLabel?.offsetHeight || 30;
    const titleH = this.chartTitleEl?.offsetHeight || 0;
    // rangeH already includes the readout's padding; reserve only the in-panel
    // TOP_INSET, no top margin.
    const rest =
      total - legendH - rangeH - titleH - TOP_INSET_PX -
      (this.minimapHeight() > 0 ? this.minimapHeight() + 4 : 0);
    return Math.max(rest, 240);
  }

  /**
   * Distribute the stack height across panes by weight (min 120 each).
   * uPlot's title bars (.u-title) render OUTSIDE opts.height, so they are
   * subtracted first — otherwise the stack overflows the root and pushes
   * the shared x-axis labels (bottom pane) and the minimap below the fold.
   * Pre-mount the titles aren't measurable yet (estimate 27px); the initial
   * ResizeObserver tick re-runs this with measured heights.
   */
  private paneHeights(): number[] {
    const { recipe } = this.opts;
    const shown = recipe.panes.map((p) => !this.hiddenPanes.has(p.id));
    // Weight by ALL panes (not just visible) so each pane's height stays constant
    // when neighbours hide — hiding removes a slot, survivors don't reflow.
    const totalWeight = recipe.panes.reduce((s, p) => s + p.heightWeight, 0) || 1;
    let stackH = this.paneStackHeight();
    for (let pi = 0; pi < recipe.panes.length; pi++) {
      if (!shown[pi]) continue;
      const title = this.panes[pi]?.plot.root.querySelector('.u-title') as HTMLElement | null;
      // Only a real uPlot title costs height (the primary title is external).
      if (title) stackH -= title.offsetHeight || 27;
    }
    const heights = recipe.panes.map((p, i) =>
      shown[i] ? Math.max(120, Math.round((stackH * p.heightWeight) / totalWeight)) : 0,
    );
    // Take rounding/min-clamp overshoot from the tallest pane so the stack stays
    // within budget.
    const excess = heights.reduce((s, h) => s + h, 0) - stackH;
    if (excess > 0) {
      const tallest = heights.indexOf(Math.max(...heights));
      heights[tallest] = Math.max(120, heights[tallest]! - excess);
    }
    return heights;
  }

  private buildLegend(): void {
    for (const s of this.opts.recipe.series)
      if (s.minimapOverlay && isSpanRenderer(s.renderer)) this.minimapSpanOverlays.set(s.key, new Map());
      else if (s.minimapOverlay)
        this.minimapOverlays.set(s.key, { column: s.columns[0]!, color: s.color, ts: new Set() });
    // Order legend groups to match the pane stack (top→bottom): a group appears
    // at its topmost pane's position, so the bottom-most lane's group (e.g.
    // Features, the state lane) reads last. Stable sort → recipe order within a
    // pane. Group ordering is thus expressed naturally by pane order in the recipe.
    const paneRank = (id: string) => {
      const i = this.opts.recipe.panes.findIndex((p) => p.id === id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const items = this.opts.recipe.series
      .filter((s) => !s.excludeFromLegend) // visual-only overlays carry no legend entry
      .sort((a, b) => paneRank(a.paneId) - paneRank(b.paneId))
      .flatMap((s) => {
        if (!isSpanRenderer(s.renderer)) {
          return [{ key: s.key, label: s.label, color: s.color, group: s.group ?? '', visible: !s.hidden }];
        }
        const cats = s.categories ?? [];
        if (cats.length < 2) {
          if (s.hidden) this.hiddenSpans.add(s.key);
          return [{
            key: s.key,
            label: s.label,
            color: spanInkColor(s, cats[0]),
            swatch: spanSwatchCss(s, cats[0]),
            group: s.group ?? '',
            visible: !s.hidden,
          }];
        }
        // One item per category, grouped under the series.
        return cats.map((c, i) => {
          if (s.hidden) this.hiddenSpans.add(`${s.key}#${i}`);
          return {
            key: `${s.key}#${i}`,
            label: c.name,
            color: spanInkColor(s, c),
            swatch: spanSwatchCss(s, c),
            group: s.group ?? s.label,
            visible: !s.hidden,
          };
        });
      });
    // Excluded span series still honour `hidden`.
    for (const s of this.spanDefs) if (s.excludeFromLegend && s.hidden) this.hiddenSpans.add(s.key);
    this.legendModel = new LegendModel(items, (key, visible) =>
      this.applySeriesVisibility(key, visible),
    );
    this.legendStrip = new LegendStrip(this.root, this.legendModel);
  }

  private labelFont(): LabelFont {
    this.legendFont ??= this.legendStrip?.entryFont() ?? null;
    return this.legendFont ?? DEFAULT_LABEL_FONT;
  }

  private minimapHeight(): number {
    const m = this.opts.minimap;
    if (m === false) return 0;
    return (typeof m === 'object' ? m.heightPx : undefined) ?? 40;
  }

  /** Minimap is a standalone, centered scrubber at 80% of the page width
   *  (decoupled from the pane-stack alignment). */
  private minimapWidth(): number {
    return Math.round((this.root.clientWidth || this.plotWidth()) * 0.8);
  }

  /** Resolve an em length (recipe units) against the root's font size. */
  private emPx(em: number): number {
    const base = parseFloat(getComputedStyle(this.root).fontSize) || 16;
    return Math.round(em * base);
  }

  private buildPanes(): void {
    const { recipe, barMs, theme } = this.opts;
    const paneHeights = this.paneHeights();
    const width = this.plotWidth();
    const syncKey = uPlot.sync(`vcn-${recipe.id}`);
    const visible = this.axis.visible;
    // Grid grey shared with the minimap line.
    const gridStroke = recipe.gridColor ?? theme?.grid;
    // Horizontal inset reserves edge room so x-axis labels don't clip as they
    // scroll off. The y-gutter side already has room, so it gets only a hair of
    // padding to clear the rounded corner; the full inset goes on the other.
    const insetPx = this.emPx(recipe.chartInsetEm ?? 0);
    const gutterInset = 8;
    const leftPad = this.opts.yAxisSide === 'left' ? gutterInset : insetPx;
    const rightPad = this.opts.yAxisSide === 'left' ? insetPx : gutterInset;
    // Primary pane: UI font. Secondary panes: tiny crisp monospace — stays
    // legible where other renderers force label hiding.
    const axisFont = (primary: boolean) =>
      primary
        ? `${theme?.axisFontPx ?? 12}px system-ui, sans-serif`
        : `${theme?.subAxisFontPx ?? 9}px Menlo, Consolas, monospace`;
    // Bottom-most pane carries the shared time labels; starts as the last pane,
    // reassigned as panes hide (updateBottomAxis).
    this.bottomVisiblePid = recipe.panes[recipe.panes.length - 1]!.id;

    for (let pi = 0; pi < recipe.panes.length; pi++) {
      const paneDef = recipe.panes[pi]!;
      const isLast = pi === recipe.panes.length - 1;
      const paneSeries = recipe.series.filter(
        (s) => s.paneId === paneDef.id && !isSpanRenderer(s.renderer),
      );
      const spanDefs = this.spanDefs.filter((d) =>
        spanPaneIds(d, recipe.panes.map((p) => p.id)).includes(paneDef.id),
      );
      // Breaking spans over this pane: lines, bands and state bars don't connect across them.
      const paneBreaks = spanDefs.some(hasBreakingCategory)
        ? (u: uPlot) => this.paneBreaks(u, paneDef.id, spanDefs)
        : undefined;
      const el = document.createElement('div');
      if (recipe.background) el.style.background = recipe.background;
      this.paneStack.appendChild(el);

      const isStateLane = !!paneDef.stateNames;
      const log = paneDef.scale === 'log';
      // Per-pane Y-label control (recipe): hide blanks them; a non-zero angle
      // routes them through the self-drawn slanted-label plugin (state lanes).
      const hideLabels = paneDef.axisLabels === 'hide';
      const labelAngle = !hideLabels ? (paneDef.axisLabelAngle ?? 0) : 0;
      // Zero top padding so all panes butt together (contiguous x-gridlines +
      // crosshair). The topmost pane's inset lives on the panel (paneStack
      // paddingTop), not here, so it follows whichever pane is on top after hides.
      const padTop = 0;

      const series: uPlot.Series[] = [{}]; // slot 0 = x
      const slots: PaneRuntime['slots'] = [];
      const adaptiveLines: PaneRuntime['adaptiveLines'] = [];
      const plugins: uPlot.Plugin[] = [];
      const bands: uPlot.Band[] = [];
      let percent: PercentOrigin | null = null;

      for (const def of paneSeries) {
        if (def.baseline) percent = new PercentOrigin();

        if (def.renderer === 'candlestick') {
          const base = series.length;
          for (const c of def.columns) {
            series.push(hiddenScaleSeries(`${def.label}·${c}`));
            slots.push({ def, column: c });
          }
          plugins.push(
            candlestickPlugin({
              open: base,
              high: base + 1,
              low: base + 2,
              close: base + 3,
              barMs,
              // Legend/host toggles flip the carrier series' show flag.
              isVisible: () => pane.plot?.series[base]?.show !== false,
            }),
          );
        } else if (def.renderer === 'band') {
          const base = series.length;
          for (const c of def.columns) {
            series.push({
              label: `${def.label}·${c}`,
              scale: 'y',
              stroke: def.color,
              // Band fill and hover dots are independent of stroke width.
              width: def.lineWidthPx ?? 1,
              show: !def.hidden,
              // Unified-timeline nulls are not data gaps — span them.
              spanGaps: true,
              ...(paneBreaks ? this.breakGapOpts(paneBreaks, 'linear') : {}),
              points: { show: false }, // no auto datapoint circles
            });
            slots.push({ def, column: c });
          }
          bands.push({ series: [base, base + 1], fill: def.color + '22' });
        } else if (def.renderer === 'state-bars') {
          const idx = series.length;
          series.push({
            label: def.label,
            scale: 'y',
            paths: () => null, // plugin paints
            points: { show: false },
            show: !def.hidden,
          });
          slots.push({ def, column: def.columns[0]! });
          plugins.push(
            stateBarsPlugin({
              seriesIdx: idx,
              colors: paneDef.stateColors,
              isVisible: () => pane.plot?.series[idx]?.show !== false,
              breaks: paneBreaks,
            }),
          );
        } else {
          // Steps for state/event holds; monotone cubic for plain lines (no
          // fabricated extrema); 'linear' opts out per series.
          const basePaths =
            def.renderer === 'state' || def.step
              ? uPlot.paths?.stepped?.({ align: 1 })
              : def.renderer === 'line' && def.curve !== 'linear'
                ? pchipPaths(paneBreaks)
                : uPlot.paths?.linear?.();
          const stepped = def.renderer === 'state' || !!def.step;
          const isPchip = def.renderer === 'line' && !def.step && def.curve !== 'linear';
          // Clip lines to loaded ranges so an unloaded gap breaks the line
          // instead of shearing across it. Break gaps (uPlot gaps) compose in.
          const paths: uPlot.Series.PathBuilder | undefined = basePaths
            ? (u, s, i0, i1) => {
                const p = basePaths(u, s, i0, i1);
                if (!p) return p;
                if (p.gaps?.length) return { ...p, clip: this.loadedClip(u, p.gaps) ?? p.clip };
                return { ...p, clip: this.loadedClip(u) };
              }
            : undefined;
          const lineBase = def.lineWidthPx ?? (def.renderer === 'state' ? 2 : 1.25);
          const lineIdx = series.length;
          series.push({
            label: def.label,
            scale: 'y',
            stroke: def.lineColor ?? def.color,
            width: lineBase,
            show: !def.hidden,
            spanGaps: true, // unified-timeline nulls are not data gaps
            ...(paneBreaks && !isPchip && def.renderer !== 'markers'
              ? this.breakGapOpts(paneBreaks, stepped ? 'stepped' : 'linear')
              : {}),
            // Suppress uPlot's auto datapoint circles (jarring across zooms);
            // showPoints opts back in for sparse event series (line+markers).
            points: def.showPoints
              ? {
                  show: true,
                  size: def.pointSizePx ?? 6,
                  stroke: def.color,
                  fill: def.color,
                }
              : { show: false },
            ...(paths ? { paths } : {}),
            ...(def.renderer === 'markers'
              ? { paths: () => null, points: { show: true, size: 6, fill: def.color } }
              : {}),
          });
          slots.push({ def, column: def.columns[0]! });
          // Plain lines taper with viewport density (drawClear hook below);
          // stepped state lines and event markers keep their constant width.
          if (def.renderer === 'line') adaptiveLines.push({ idx: lineIdx, base: lineBase });
        }
      }

      const pane: PaneRuntime = {
        id: paneDef.id,
        el,
        plot: null as unknown as uPlot,
        slots,
        log,
        isStateLane,
        // Log scales need strictly positive bounds before first data.
        yRange: isStateLane
          ? [-0.5, (paneDef.stateNames!.length - 1) + 0.5]
          : log
            ? [1, 10]
            : [0, 1],
        percent,
        manualY: false,
        adaptiveLines,
        spanDefs,
      };

      plugins.push(
        gesturePlugin({
          propose: (r) => this.axis.propose(r, 'gesture'),
          boxZoom: (r) => {
            this.zoomStack.push({ ...this.axis.visible });
            if (this.zoomStack.length > 40) this.zoomStack.shift();
            this.axis.propose(r, 'gesture');
          },
          popZoom: () => this.popZoom(),
          toggleHover: (cx, cy, isTouch) => this.toggleHoverLegend(cx, cy, isTouch),
          setActive: (active) => {
            this.gestureActive = active;
            if (active) this.hideTooltip();
          },
        }),
      );

      // Slanted Y-labels: uPlot can't rotate Y axes, so draw category labels in
      // the reserved gutter ourselves.
      if (isStateLane && labelAngle) {
        plugins.push(
          angledAxisLabels({
            labels: paneDef.stateNames!,
            angleDeg: labelAngle,
            side: this.opts.yAxisSide === 'left' ? 3 : 1,
            gutterPx: AXIS_GUTTER_PX,
            fontPx: theme?.subAxisFontPx ?? 9,
            color: theme?.axis ?? '#6b7280',
          }),
        );
      }

      // vrect/vline layers; pushed last so 'above' paints over every other plugin.
      if (spanDefs.length) {
        plugins.push(
          spansPlugin({
            defs: spanDefs,
            store: (key) => this.stores.get(key),
            visible: (def, cat) => this.spanVisible(def, cat),
            labelsHere: (def) => this.spanLabelPane(def) === paneDef.id,
            labelFont: () => this.labelFont(),
          }),
        );
      }

      // Faint centred watermark on the primary pane only (recipe-driven).
      const watermark = pi === 0 && recipe.watermark ? makeWatermark(recipe.watermark) : null;

      const uOpts: uPlot.Options = {
        width,
        height: paneHeights[pi]!,
        // Primary title is the external heading (chartTitleEl); subplot titles
        // come from the recipe (unset = hidden).
        title: pi === 0 ? undefined : paneDef.title,
        // Uniform fixed padding: uPlot otherwise auto-pads only the panes whose
        // x-axis shows labels, breaking stack alignment. The horizontal inset
        // reserves edge room for scrolling x-labels.
        padding: [padTop, rightPad, 0, leftPad],
        ms: 1, // x values are UTC milliseconds
        tzDate: (ts) => uPlot.tzDate(new Date(ts), 'Etc/UTC'), // UTC axis math
        scales: {
          x: { time: true, min: visible.from, max: visible.to },
          y: {
            auto: false,
            ...(log ? { distr: 3 as const } : {}),
            range: () => pane.yRange,
          },
        },
        series,
        bands: bands.length ? bands : undefined,
        axes: [
          {
            // Shown on EVERY pane so the x-grid renders throughout the stack;
            // identical split inputs keep the vertical lines aligned across panes.
            show: true,
            // Only the bottom-most VISIBLE pane spends label space; rest collapse
            // to 0. An explicit literal lets updateBottomAxis() mutate size on
            // hide/show.
            size: isLast ? X_AXIS_LABEL_PX : 0,
            // Short ticks + small gap so labels fit the tightened band.
            ticks: { show: isLast, size: 4 },
            gap: 3,
            // Primary font on EVERY pane so any pane can become the label-bearer
            // without a runtime font swap.
            font: axisFont(true),
            grid: { show: true, ...(gridStroke ? { stroke: gridStroke } : {}) },
            ...(theme?.axis ? { stroke: theme.axis } : {}),
            splits: (u: uPlot) => {
              const xMin = u.scales['x']?.min ?? visible.from;
              const xMax = u.scales['x']?.max ?? visible.to;
              const ticks = tvTimeTicks(xMin, xMax, {
                widthPx: u.bbox.width / (window.devicePixelRatio || 1),
                fontPx: theme?.axisFontPx ?? 12,
              });
              pane.timeTickLabels = new Map(ticks.map((tk) => [tk.t, tk.label]));
              return ticks.map((tk) => tk.t);
            },
            filter: (_u: uPlot, splits: (number | null)[]) => splits,
            values: (_u: uPlot, splits: (number | null)[]) =>
              this.bottomVisiblePid === paneDef.id
                ? splits.map((s) => (s == null ? '' : (pane.timeTickLabels?.get(s) ?? '')))
                : splits.map(() => ''),
          },
          {
            // Uniform gutter across all panes (alignment); secondary panes get
            // the tiny crisp monospace.
            size: AXIS_GUTTER_PX,
            font: axisFont(pi === 0),
            side: this.opts.yAxisSide === 'left' ? 3 : 1, // default: right
            // State lanes draw no horizontal gridlines — a line per ordinal
            // shreds the colored bars; labels alone carry the scale.
            grid: isStateLane
              ? { show: false }
              : { show: true, ...(gridStroke ? { stroke: gridStroke } : {}) },
            ...(theme?.axis ? { stroke: theme.axis } : {}),
            ...(isStateLane
              ? {
                  splits: () => paneDef.stateNames!.map((_, i) => i),
                  // Blank when hidden or slanted (the plugin draws angled text);
                  // otherwise the horizontal label the gutter holds.
                  values: () =>
                    hideLabels || labelAngle
                      ? paneDef.stateNames!.map(() => '')
                      : paneDef.stateNames!.map((n) =>
                          n.length > 13 ? n.slice(0, 12) + '…' : n,
                        ),
                }
              : {
                  // Tick step from the {1,2,2.5,4,5}×10^k ladder at ~2.5
                  // font-heights per mark; log panes re-derive the step from
                  // local pixel density so labels stay nice values.
                  splits: (u: uPlot) => {
                    const [lo, hi] = pane.yRange;
                    const fontPx = pi === 0
                      ? (theme?.axisFontPx ?? 12)
                      : (theme?.subAxisFontPx ?? 9);
                    const tickOpts = {
                      heightPx: u.bbox.height / (window.devicePixelRatio || 1),
                      fontPx,
                    };
                    const ticks =
                      this.percentMode && pane.percent?.origin
                        ? tvPercentTicks(pane.percent.origin, lo, hi, tickOpts)
                        : pane.log
                          ? tvLogTicks(lo, hi, tickOpts)
                          : tvLinearTicks(lo, hi, tickOpts);
                    // Drop ticks whose label would clip at the top/bottom edge
                    // (gridline + label together). Margin ≈ label half-height.
                    const dpr = window.devicePixelRatio || 1;
                    const m = fontPx * dpr * 0.7;
                    const top = u.bbox.top + m;
                    const bot = u.bbox.top + u.bbox.height - m;
                    return ticks.filter((v) => {
                      const y = u.valToPos(v, 'y', true);
                      return y >= top && y <= bot;
                    });
                  },
                  // Splits are already nice — bypass uPlot's built-in label
                  // filter (the log-scale one nulls entries, crashing values()
                  // at extreme zoom-out).
                  filter: (_u: uPlot, splits: (number | null)[]) => splits,
                  values: (u: uPlot, splits: (number | null)[]) =>
                    hideLabels
                      ? splits.map(() => '')
                      : this.percentMode && pane.percent
                        ? pane.percent.formatSplits(splits)
                        : paneDef.axisFormat
                          ? splits.map((v) =>
                              v == null ? '' : formatHoverNumber(v, paneDef.axisFormat),
                            )
                          : splits.map((v) => formatNative(v)),
                }),
          },
        ],
        cursor: {
          // Sync the x (time) crosshair across panes only. uPlot's default also
          // syncs y (every pane shares scale 'y'), leaking a horizontal crosshair
          // onto other panes. Keep the y key non-null but force its matcher false
          // so uPlot hides y on synced panes (_t = -10); a null y key would
          // instead pixel-fraction-sync it — still a leak. match[2] (series-index
          // matcher) must stay valid — the subscribe path always calls it.
          sync: {
            key: syncKey.key,
            scales: ['x', 'y'],
            match: [(a, b) => a === b, () => false, (_s: uPlot, _src: uPlot, i: number) => i],
          },
          // Snap the crosshair to the nearest sample time so it lands on the
          // bars the hover legend reads. All panes snap to the PRIMARY pane's
          // grid (shared x scale + width) so the line stays aligned.
          move: (u: uPlot, left: number, top: number): [number, number] => [
            this.snapCursorLeft(u, left),
            top,
          ],
          // Causal per-series hover index: resolve to the last sample AT OR
          // BEFORE the cursor (uPlot's default scans both ways). Keeps the hover
          // ring on the point the legend reports.
          dataIdx: (u: uPlot, sidx: number, hovIdx: number, xval: number): number => {
            const xs = u.data[0] as ArrayLike<number>;
            const ys = u.data[sidx] as ArrayLike<number | null | undefined>;
            if (sidx === 0 || !xs || !ys || xs.length === 0) return hovIdx;
            // Floor: largest index whose time ≤ the cursor x value.
            let lo = 0;
            let hi = xs.length;
            while (lo < hi) {
              const m = (lo + hi) >>> 1;
              if (xs[m]! <= xval) lo = m + 1;
              else hi = m;
            }
            const floor = lo - 1;
            if (floor < 0) return hovIdx;
            for (let d = 0; d <= 64 && floor - d >= 0; d++) {
              if (ys[floor - d] != null) return floor - d;
            }
            return hovIdx;
          },
          // Hover marker: solid series-colour dot with a faint same-colour halo
          // (soft edge). Suppressed (0-size/0-width) on candles and state lanes,
          // which have no meaningful point.
          points: {
            size: (_u: uPlot, sidx: number): number =>
              isRingSeries(slots[sidx - 1]?.def.renderer)
                ? (slots[sidx - 1]?.def.pointSizePx ?? 5) + 2
                : 0,
            width: (_u: uPlot, sidx: number): number =>
              isRingSeries(slots[sidx - 1]?.def.renderer) ? 1 : 0,
            // Dot colour is the series IDENTITY (def.color), not lineColor —
            // which on a sparse event series is a muted grey connector.
            fill: (_u: uPlot, sidx: number): string => {
              const def = slots[sidx - 1]?.def;
              return isRingSeries(def?.renderer) ? dotColor(def) : 'transparent';
            },
            stroke: (_u: uPlot, sidx: number): string =>
              withAlpha(dotColor(slots[sidx - 1]?.def), 0.4),
          },
          // uPlot's select/zoom is fully disabled — the gesture plugin owns pan,
          // box zoom and reset; native mousedown/dblclick suppressed so they
          // can't fight it.
          drag: { x: false, y: false, setScale: false },
          bind: {
            mousedown: () => () => null,
            dblclick: () => () => null,
          },
        },
        legend: { show: false }, // replaced by the library legend strip
        hooks: {
          // Density-adaptive line thinning: when many source bars fall per CSS
          // pixel (zoomed out), taper each plain line from its recipe width
          // toward a crisp device-pixel hairline so the dense LTTB envelope reads
          // as a shape, not a smear. Linear in log10(density) base→floor up to
          // DENSITY_FLOOR_BARS_PER_PX (a gentle drop-off). Runs every draw →
          // tracks zoom, resize, cached navigations and dpr changes across
          // displays; ≤1 bar/px leaves the line untouched.
          drawClear: [
            (u: uPlot) => {
              if (pane.adaptiveLines.length === 0) return;
              const sx = u.scales['x'];
              const dpr = window.devicePixelRatio || 1;
              const cssPx = u.bbox.width / dpr;
              if (sx?.min == null || sx?.max == null || !(cssPx > 0)) return;
              const barsPerPx = (sx.max - sx.min) / this.opts.barMs / cssPx;
              const floor = (this.opts.minLineWidthDevicePx ?? 1) / dpr; // device hairline
              const densityFloor = this.opts.lineWidthDensityFloor ?? DENSITY_FLOOR_BARS_PER_PX;
              const progress = Math.min(
                1,
                Math.max(0, Math.log10(barsPerPx) / Math.log10(densityFloor)),
              );
              for (const al of pane.adaptiveLines) {
                const s = u.series[al.idx];
                if (!s) continue;
                const lo = Math.min(floor, al.base); // never exceed the recipe width
                s.width = al.base - (al.base - lo) * progress;
              }
            },
          ],
          setCursor: [(u: uPlot) => this.onCursor(u, pane)],
          // Re-fit the watermark on resize. (Empty array, not undefined — uPlot
          // concats hook arrays and would call a nullish entry.)
          setSize: watermark ? [(u: uPlot) => watermark.fit(u)] : [],
          ready: [
            (u: uPlot) => {
              // Point actions: a plain click (no drag) dispatches the hook with
              // point identity if the pane's series declare actions.
              let downX = 0;
              let downY = 0;
              u.over.addEventListener('mousedown', (e) => {
                downX = e.clientX;
                downY = e.clientY;
              });
              u.over.addEventListener('click', (e) => {
                if (Math.abs(e.clientX - downX) > 3 || Math.abs(e.clientY - downY) > 3) return;
                this.onPaneClick(u, pane);
              });
              watermark?.mount(u);
              watermark?.fit(u);
              if (this.spanDefs.length) {
                // Capture phase: record the raw pointer before uPlot snaps the cursor.
                u.root.addEventListener(
                  'mousemove',
                  (e) => {
                    this.rawPointer = { u, left: e.clientX - u.over.getBoundingClientRect().left };
                  },
                  true,
                );
                u.over.addEventListener('mouseleave', () => {
                  if (this.rawPointer?.u === u) this.rawPointer = null;
                });
              }
            },
          ],
        },
        plugins,
      };

      const emptyData = [[], ...series.slice(1).map(() => [])] as unknown as uPlot.AlignedData;
      pane.plot = new uPlot(uOpts, emptyData, el);
      const titleEl = el.querySelector('.u-title') as HTMLElement | null;
      if (titleEl) {
        // Recipe-set title weight (lighter than uPlot's bold).
        if (recipe.titleWeight) titleEl.style.fontWeight = String(recipe.titleWeight);
        // Subplot titles: nudge down toward their own plot, gap above so they
        // read with the chart below.
        if (pi > 0) {
          titleEl.style.lineHeight = '1.15';
          titleEl.style.padding = `${SUBPLOT_TITLE_TOP_GAP}px 0 1px`;
        }
      }
      this.wireAxisDragZoom(pane, isLast);
      this.panes.push(pane);
    }
  }

  private updateRangeLabel(range: TimeRange): void {
    if (!this.rangeText) return;
    this.rangeText.textContent =
      `${formatHoverDate(range.from, 'YYYY-MM-DD HH:mm')} → ` +
      `${formatHoverDate(range.to, 'YYYY-MM-DD HH:mm')} UTC`;
  }

  /**
   * Plotly-convention axis drag-zoom: dragging the
   * Y-axis gutter expands/compresses that pane's scale (suspending autofit
   * until the next navigation or an axis double-click); dragging the X-axis
   * strip zooms the shared time axis about its center.
   */
  private wireAxisDragZoom(pane: PaneRuntime, hasXAxis: boolean): void {
    const u = pane.plot;
    const root = u.root;
    let mode: 'x' | 'y' | null = null;
    let startX = 0;
    let startY = 0;
    let startYRange: [number, number] | null = null;
    let startVisible: TimeRange | null = null;

    const inYStrip = (cx: number) => {
      const r = u.over.getBoundingClientRect();
      return this.opts.yAxisSide === 'left' ? cx < r.left : cx > r.right;
    };
    const inXStrip = (cx: number, cy: number) => {
      const r = u.over.getBoundingClientRect();
      return hasXAxis && cy > r.bottom && cx >= r.left && cx <= r.right;
    };

    root.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.target && u.over.contains(e.target as Node)) return; // plot area = gestures
      if (inYStrip(e.clientX) && !pane.isStateLane) {
        mode = 'y';
        startY = e.clientY;
        startYRange = [pane.yRange[0], pane.yRange[1]];
      } else if (inXStrip(e.clientX, e.clientY)) {
        mode = 'x';
        startX = e.clientX;
        startVisible = this.axis.visible;
      } else {
        return;
      }
      this.gestureActive = true;
      this.hideTooltip();
      try {
        root.setPointerCapture(e.pointerId);
      } catch {
        // inactive pointer (synthetic events)
      }
      e.preventDefault();
    });

    root.addEventListener('pointermove', (e: PointerEvent) => {
      if (mode === 'y' && startYRange) {
        // drag down = zoom out, drag up = zoom in (about the pane center)
        const factor = Math.exp((e.clientY - startY) * 0.004);
        const [lo, hi] = startYRange;
        if (pane.log) {
          const llo = Math.log10(Math.max(lo, 1e-12));
          const lhi = Math.log10(Math.max(hi, 1e-12));
          const mid = (llo + lhi) / 2;
          const half = ((lhi - llo) / 2) * factor;
          pane.yRange = [Math.pow(10, mid - half), Math.pow(10, mid + half)];
        } else {
          const mid = (lo + hi) / 2;
          const half = ((hi - lo) / 2) * factor;
          pane.yRange = [mid - half, mid + half];
        }
        pane.manualY = true;
        u.setScale('y', { min: pane.yRange[0], max: pane.yRange[1] });
      } else if (mode === 'x' && startVisible) {
        // drag right = zoom in (Plotly axis-drag convention)
        const factor = Math.exp((startX - e.clientX) * 0.003);
        const mid = (startVisible.from + startVisible.to) / 2;
        const half = ((startVisible.to - startVisible.from) / 2) * factor;
        this.axis.propose({ from: mid - half, to: mid + half }, 'gesture');
      }
    });

    const end = () => {
      if (mode !== null) this.gestureActive = false;
      mode = null;
      startYRange = null;
      startVisible = null;
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);

    root.addEventListener('dblclick', (e: MouseEvent) => {
      if (e.target && u.over.contains(e.target as Node)) return;
      if (inYStrip(e.clientX)) {
        pane.manualY = false;
        this.refitVisible();
      }
    });
  }

  private buildMinimap(): void {
    if (this.minimapHeight() === 0) return;
    this.minimapEl = document.createElement('div');
    if (this.opts.recipe.minimapBackground) {
      this.minimapEl.style.background = this.opts.recipe.minimapBackground;
    }
    // Standalone, centered: 80% of the page, no pane-gutter alignment.
    this.minimapEl.style.margin = '0 auto';
    this.minimapEl.style.width = `${this.minimapWidth()}px`;
    this.root.appendChild(this.minimapEl);
    this.minimap = new Minimap(this.minimapEl, {
      axis: this.axis,
      heightPx: this.minimapHeight(),
      width: this.minimapWidth(),
      gutterPx: 0,
      // Data-shadow line = chart grid grey; fill = chart background.
      color: this.opts.recipe.gridColor,
      fill: this.opts.recipe.minimapFill,
    });
  }

  /** Re-fit pane + minimap sizes to the root element. */
  private resize(): void {
    if (this.destroyed) return;
    const paneHeights = this.paneHeights();
    const width = this.plotWidth();
    for (let pi = 0; pi < this.panes.length; pi++) {
      if (this.hiddenPanes.has(this.panes[pi]!.id)) continue; // collapsed: skip
      this.panes[pi]!.plot.setSize({
        width,
        height: paneHeights[pi]!,
      });
    }
    if (this.minimapEl) this.minimapEl.style.width = `${this.minimapWidth()}px`;
    this.minimap?.setWidth(this.minimapWidth());
    this.updateZoomClamp(); // pitch term is width-dependent
    // New width changes the point budget — re-evaluate density on settle.
    this.scheduleSettle(this.axis.visible);
  }

  /** Client mirror of the server's CandleBucketMs (pitch floor 6 CSS px;
   *  nested multiple of the shared bucket). */
  private candleBucketMs(spanMs: number, widthPx: number, sharedBucketMs: number): number {
    const maxCandles = Math.max(1, Math.floor(Math.max(widthPx, 1) / 6));
    const barMs = this.opts.barMs;
    const pitchBucket = Math.max(1, Math.ceil(spanMs / maxCandles / barMs)) * barMs;
    if (pitchBucket <= sharedBucketMs) return sharedBucketMs;
    return Math.ceil(pitchBucket / sharedBucketMs) * sharedBucketMs;
  }

  /** Perception-based max-magnification clamp (types.ts zoomClamp). */
  private updateZoomClamp(): void {
    const clamp = this.opts.zoomClamp;
    this.axis.minSpanMs = minVisibleSpanMs(
      this.opts.barMs,
      this.plotWidth(),
      clamp?.maxBarPitchPx,
      clamp?.minVisibleBars,
    );
  }

  // ------------------------------------------------- navigation frame cycle

  /** External navigation (range-preset toolbar, jump-to-date). A deliberate
   *  jump establishes a fresh viewport context, so the box-zoom undo history
   *  is discarded — a subsequent double-tap resets to default, not back into a
   *  pre-preset zoom the user has moved on from. */
  navigateTo(range: TimeRange): void {
    this.zoomStack.length = 0;
    this.axis.propose(range, 'navigate');
  }

  /**
   * The single axis-change path: every producer (gesture, brush, navigateTo)
   * lands here. Instant local preview (scale-only) + debounced settle.
   */
  private onAxisChange(range: TimeRange, cause: NavigationCause): void {
    this.updateRangeLabel(range);
    // Navigating invalidates the hovered point: hide the label and drop a
    // long-press PIN (its point moved). A 'hidden' suppression persists (user
    // chose it).
    if (this.hoverState === 'pinned') this.hoverState = 'live';
    this.hideTooltip();
    // Horizontal navigation restores Y-autofit; manual axis-drag zoom is a
    // transient inspection state that refits on the next nav.
    for (const p of this.panes) p.manualY = false;
    this.refitVisible();
    this.updateSkeletonState();
    this.opts.hooks.onVisibleChange?.(range, cause);
    // Continuous drags (pane gestures + minimap brush) feed the velocity
    // estimate and may trigger an interim mid-drag refill. Discrete jumps
    // (presets, 'navigate') have no motion to project — clear the estimate.
    // 'program' is our own snap.
    if (cause === 'gesture' || cause === 'brush') {
      this.sampleVelocity(range);
      this.maybeInterimFetch(range);
    } else if (cause !== 'program') {
      this.resetVelocity();
    }
    if (cause !== 'program') this.scheduleSettle(range);
  }

  /** Difference the live range against the previous sample into a smoothed,
   *  signed content velocity, and hold the fling's peak for the settle
   *  projection. A long gap or a reversal starts a fresh fling. */
  private sampleVelocity(range: TimeRange): void {
    const now = performance.now();
    const prev = this.prevLiveRange;
    const prevMs = this.prevLiveMs;
    this.prevLiveRange = range;
    this.prevLiveMs = now;
    if (!prev) return;
    const dt = now - prevMs;
    if (dt <= 0 || dt > VELOCITY_GAP_RESET_MS) {
      // Motion broke (pause / new gesture) — don't project a phantom fling.
      this.panVelocity = 0;
      this.flingPeak = 0;
      this.flingDir = 0;
      return;
    }
    // Average edge motion: a pan moves both edges equally; a zoom moves them
    // oppositely → ~0, so a zoom never reads as pan velocity.
    const shift = (range.from - prev.from + (range.to - prev.to)) / 2;
    const v = shift / dt; // data-ms per wall-ms, signed
    const sign = Math.sign(v);
    if (this.flingDir !== 0 && sign !== 0 && sign !== this.flingDir) {
      this.flingPeak = 0; // reversed — forget the old fling's peak
    }
    this.panVelocity = VELOCITY_EWMA * v + (1 - VELOCITY_EWMA) * this.panVelocity;
    if (Math.abs(this.panVelocity) > this.flingPeak) {
      this.flingPeak = Math.abs(this.panVelocity);
      this.flingDir = Math.sign(this.panVelocity);
    }
  }

  private resetVelocity(): void {
    this.prevLiveRange = null;
    this.panVelocity = 0;
    this.flingPeak = 0;
    this.flingDir = 0;
  }

  /** Inertial stopping distance (signed data-ms) for the fling that just
   *  happened, clamped to a sane multiple of the viewport. Uses the peak
   *  velocity so the lead reflects the whole swipe, not its decayed tail. */
  private projectLeadMs(span: number): number {
    const reach = this.flingPeak * this.flingDir * INERTIA_TAU_MS;
    return Math.sign(reach) * Math.min(Math.abs(reach), LEAD_MAX_FRAC * span);
  }

  /** Prefetch floor in data-ms: the viewport span scaled to PREFETCH_FLOOR_CM
   *  of the chart's physical width (zoom-independent), capped at the hard lead
   *  ceiling. This is the "≥ 30 cm of chart ahead" floor the lead is max'd to. */
  private prefetchFloorMs(span: number): number {
    const w = this.panes[0]?.plot.over.clientWidth || this.plotWidth();
    const floorPx = PREFETCH_FLOOR_CM * CSS_PX_PER_CM;
    return Math.min(span * (floorPx / Math.max(w, 1)), LEAD_MAX_FRAC * span);
  }

  /** While a fling is still in flight, fetch the strip we are about to enter
   *  before the settle debounce would — so a sustained/fast pan never out-runs
   *  the loaded edge. Guarded by a throttle and a coverage check so it fires at
   *  most once per strip, not every frame. */
  private maybeInterimFetch(range: TimeRange): void {
    const span = range.to - range.from;
    const reach = this.panVelocity * INERTIA_TAU_MS; // live speed, not peak
    if (Math.abs(reach) < span * LEAD_MIN_FRAC) return; // slow: settle covers it
    const now = performance.now();
    if (now - this.lastInterimMs < INTERIM_MIN_GAP_MS) return;
    // Floor the refill at the physical-distance lead; cap at the hard ceiling.
    const lead = Math.min(
      Math.max(Math.abs(reach), this.prefetchFloorMs(span)),
      LEAD_MAX_FRAC * span,
    );
    const ahead =
      reach > 0
        ? this.axis.clamp({ from: range.to, to: range.to + lead })
        : this.axis.clamp({ from: range.from - lead, to: range.from });
    if (this.loaded.missing(ahead).length === 0) return; // already loaded
    this.lastInterimMs = now;
    this.requestNavigation(this.axis.visible, false);
  }

  private scheduleSettle(range: TimeRange): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      // Lock the visible span to an integer candle pitch so the grid tiles at
      // exactly P device px (pixel-equal gaps). Only on SETTLE so live gestures
      // stay smooth; 'program' does not re-arm the settle.
      const snapped = this.quantizeToCandleGrid(this.axis.visible);
      if (snapped) this.axis.propose(snapped, 'program');
      this.requestNavigation(this.axis.visible, false);
    }, this.opts.settleMs);
  }

  /**
   * Snap the visible span so the candle bucket pitch is an integer number of
   * device pixels — the only way to strictly pixel-equal gaps on a
   * time-proportional axis (the residual is otherwise a 1px Bresenham
   * alternation). The span shifts ≤ ~4% at the pitch floor (less when zoomed
   * in), centered so the time slop splits to ±half at the edges. Returns null
   * when there are no candles or the pitch is already integer.
   */
  private quantizeToCandleGrid(range: TimeRange): TimeRange | null {
    const hasCandles = this.opts.recipe.series.some((s) => s.renderer === 'candlestick');
    if (!hasCandles) return null;
    const u = this.panes[0]?.plot;
    if (!u) return null;
    const dpr = window.devicePixelRatio || 1;
    const W = u.bbox?.width || u.over.clientWidth * dpr; // device px
    const span = range.to - range.from;
    if (!(W > 0) || !(span > 0)) return null;

    // Mirror candles.ts groupMs (minPitchPx default 6).
    const barMs = this.opts.barMs;
    const pxPerMs = W / span;
    const minPitchMs = (6 * dpr) / pxPerMs;
    const groupMs = Math.max(1, Math.ceil(minPitchMs / barMs)) * barMs;

    const pitchPx = groupMs * pxPerMs;
    const P = Math.max(1, Math.round(pitchPx));
    if (Math.abs(pitchPx - P) < 0.02) return null; // already integer-pitched

    const newSpan = (groupMs * W) / P;
    // Anchor the right edge, don't re-center: re-centering drifts `to` by the
    // snap residual, so revisiting a span would miss the cache. Pinning `to`
    // makes the snapped range a fixed point per (to, span) — toggling 1d/1w at
    // the live edge reproduces the identical range and stays on the latest bar.
    return this.axis.clamp({ from: range.to - newSpan, to: range.to });
  }

  /** Build the fetch plan for `range` and emit a navigation request if needed. */
  private requestNavigation(range: TimeRange, initial: boolean): void {
    // Frozen snapshot: no backend, single captured tier. Skip the tier switch +
    // fetch (a resize would otherwise drop into an empty tier and strand the
    // skeleton); just redraw.
    if (this.frozen) {
      this.renderActiveTier();
      this.updateSkeletonState();
      return;
    }
    const span = range.to - range.from;
    // Directional prefetch: base pad both sides, plus a velocity-projected lead
    // in the travel direction (the fling's v·τ stopping distance) so a continued
    // swipe stays ahead of the unloaded edge.
    let padLeft = span * PREFETCH_FRAC;
    let padRight = span * PREFETCH_FRAC;
    if (!initial) {
      const reach = this.projectLeadMs(span);
      if (reach !== 0) {
        const lead = Math.max(Math.abs(reach), this.prefetchFloorMs(span));
        if (reach > 0) padRight += lead;
        else padLeft += lead;
      }
    }
    const padded = this.axis.clamp({ from: range.from - padLeft, to: range.to + padRight });

    // Use the DRAWN plot-area width (excludes the Y gutter) so the server's
    // pitch/density math matches what the user sees.
    const width = this.panes[0]?.plot.over.clientWidth || this.plotWidth();
    const maxPoints = Math.max(100, Math.round(width * this.opts.pointsPerPx));
    const neededBucketMs = Math.max(this.opts.barMs, span / maxPoints);
    // ONE density value drives tier selection, the request, and cache routing,
    // so a fragment caches into exactly the tier its request loaded into — no
    // rounding drift between selectTier and tierKey on commit.
    const sampleIntervalMs = Math.round(neededBucketMs);

    // Candles fetch on their own coarser pitch-floored grid — mirror the
    // server's CandleBucketMs so the candle density bands the tier (below).
    const candleNeededBucketMs = this.candleBucketMs(span, width, neededBucketMs);

    // Switch to the tier for this (line, candle) density band. A >2× change in
    // either density crosses a band → a different (empty) tier → fetch; within a
    // band the held data is reused. No in-place clear — siblings persist.
    const prevTier = this.activeTier;
    this.selectTier(sampleIntervalMs, candleNeededBucketMs);
    const switchedTier = this.activeTier !== prevTier;

    // Partition the fetch into prioritised LANES: the viewport paints first
    // (priority 0); each prefetch pad rides its own lane. The three disjoint
    // sub-ranges together cover missing(padded).
    const visibleMissing = this.loaded.missing(range);
    const aheadMissing = this.loaded.missing(this.axis.clamp({ from: range.to, to: padded.to }));
    const behindMissing = this.loaded.missing(
      this.axis.clamp({ from: padded.from, to: range.from }),
    );
    // Skeleton greys only when the VIEWPORT needs loading this frame; a
    // cache-covered viewport's background prefetch fills its pads silently.
    this.frameHasVisibleFetch = visibleMissing.length > 0;
    if (
      visibleMissing.length === 0 &&
      aheadMissing.length === 0 &&
      behindMissing.length === 0 &&
      !initial
    ) {
      // Covered at adequate density — local commit only. A tier SWITCH still
      // needs a render (the panes hold the old tier's data).
      if (switchedTier) this.renderActiveTier();
      this.refitVisible();
      // Coverage complete (no fetch) — clear any skeleton the gesture set, else
      // an expand onto a cached band stays stuck grey (no commit to clear it).
      this.updateSkeletonState();
      this.setStatus('idle');
      return;
    }

    // Eviction: bound memory to a multiple of the viewport.
    const keep = this.axis.clamp({
      from: range.from - span * EVICT_FACTOR,
      to: range.to + span * EVICT_FACTOR,
    });
    for (const s of this.stores.values()) s.evictOutside(keep);
    this.loaded.retainWithin(keep);

    // Dynamic priority: the pad in the travel direction (this viewport vs the
    // last one we RECEIVED visible data for) outranks the trailing pad. Visible
    // is always 0; idle / first request ⇒ ahead leads.
    const travel =
      this.lastReceivedVisibleFrom == null ? 1 : range.from - this.lastReceivedVisibleFrom;
    const aheadAligned = travel >= 0;
    const emit = (laneId: string, priority: number, fetchRanges: TimeRange[]): void => {
      if (fetchRanges.length === 0) return;
      const phaseId = this.coordinator.beginPhase(laneId);
      // Remember which tier this phase fetches for, so its fragments cache into
      // the right band even if a later nav switches the active tier.
      this.phaseTier.set(`${laneId}:${phaseId}`, this.activeTier);
      while (this.phaseTier.size > 64) {
        const oldest = this.phaseTier.keys().next().value as string;
        this.phaseTier.delete(oldest);
      }
      this.opts.hooks.requestFrame({
        laneId,
        priority,
        phaseId,
        visible: range,
        fetchRanges,
        widthPx: width,
        maxPointsPerSeries: maxPoints,
        // Viewport-density sampling interval: the provider quantizes to this
        // grid, keeping client and server bucketing in exact agreement.
        sampleIntervalMs,
      });
    };

    emit(this.visibleLane, 0, visibleMissing);
    emit(this.aheadLane, aheadAligned ? 1 : 2, aheadMissing);
    emit(this.behindLane, aheadAligned ? 2 : 1, behindMissing);

    // Only the visible lane drives the loading indicator + travel marker;
    // prefetch lanes fill silently.
    if (visibleMissing.length > 0) {
      this.visibleRequestFrom = range.from;
      this.setStatus('loading');
    }
    // Skeleton is keyed on lane state — turn it on once a real viewport fetch is
    // dispatched (no-op when the viewport was cached).
    this.updateSkeletonState();
  }

  /** Host feeds fragments here; the barrier commits when the phase is complete. */
  acceptFragment(fragment: SeriesFragment): void {
    if (this.destroyed) return;
    // Cache EVERY delivered fragment (even stale/cache-only) into the tier its
    // request was emitted for, so an abandoned nav still fills the cache and a
    // commit lands in the right band. Skip empty fragments — a zero-row range
    // must stay "unloaded" so it's re-fetched once data exists.
    if (fragment.xs.length > 0) {
      const tier = this.phaseTier.get(`${fragment.laneId}:${fragment.phaseId}`);
      if (tier) {
        tier.stores.get(fragment.seriesKey)?.merge(fragment);
        tier.loaded.add(fragment.range);
      }
    }
    // Accumulate recipe-flagged minimap-overlay points (e.g. undefined-factor
    // markers) from EVERY delivered fragment, widening coverage as we browse.
    const ov = this.minimapOverlays.get(fragment.seriesKey);
    if (ov && fragment.xs.length > 0) {
      const col = fragment.columns[ov.column];
      let added = false;
      if (col)
        for (let i = 0; i < col.length; i++)
          if (col[i] != null && Number.isFinite(col[i] as number)) {
            ov.ts.add(fragment.xs[i]!);
            added = true;
          }
      if (added) this.pushMinimapOverlay();
    }
    const spanOv = this.minimapSpanOverlays.get(fragment.seriesKey);
    if (spanOv && fragment.xs.length > 0) {
      const def = this.spanDefs.find((d) => d.key === fragment.seriesKey)!;
      const { end, category } = spanColumns(def);
      for (let i = 0; i < fragment.xs.length; i++) {
        const cat = Math.round((category ? fragment.columns[category]?.[i] : null) ?? 0);
        const to = end ? (fragment.columns[end]?.[i] ?? undefined) : undefined;
        spanOv.set(fragment.xs[i]!, {
          to: def.renderer === 'vrect' ? to : undefined,
          color: spanInkColor(def, def.categories?.[cat]),
        });
      }
      this.pushMinimapOverlay();
    }

    // A cache-only partial never drives the phase barrier — buffered, not
    // rendered.
    if (!fragment.cacheOnly) this.coordinator.accept(fragment);
  }

  /** Flatten accumulated overlay events to the minimap (recipe-driven dots). */
  private pushMinimapOverlay(): void {
    if (!this.minimap) return;
    const pts: Array<{ t: UtcMillis; to?: UtcMillis; color: string }> = [];
    for (const m of this.overviewMarks) pts.push({ t: m.t, to: m.to ?? undefined, color: m.color });
    for (const ov of this.minimapOverlays.values())
      for (const t of ov.ts) pts.push({ t, color: ov.color });
    for (const ov of this.minimapSpanOverlays.values())
      for (const [t, v] of ov) pts.push({ t, to: v.to, color: v.color });
    this.minimap.setOverlay(pts);
  }

  /** Host-reported phase failure: keep the last good frame, surface it. Only
   *  the visible lane surfaces errors — a prefetch failure is silent (the
   *  buffer just stays unfilled; the next pan re-requests). */
  failPhase(laneId: string, phaseId: number, message: string): void {
    if (this.destroyed) return;
    if (laneId === this.visibleLane && phaseId >= this.coordinator.committedPhase(laneId)) {
      this.setStatus('error', message);
    }
  }

  /** Library-owned status chip + host hook, one path. */
  private setStatus(status: 'idle' | 'loading' | 'error', detail?: string): void {
    const chip = this.statusChip;
    // 'loading' shows no chip (the skeleton signals it); errors surface, idle
    // hides.
    if (status === 'error') {
      chip.style.display = 'block';
      chip.textContent = `error: ${detail ?? 'failed'}`;
      chip.style.background = 'rgba(239,83,80,.2)';
      chip.style.color = '#ef5350';
    } else {
      chip.style.display = 'none';
    }
    this.opts.hooks.onStatus?.(status, detail);
  }

  /** Point-action dispatch: nearest action-bearing series at the cursor. */
  private onPaneClick(u: uPlot, pane: PaneRuntime): void {
    const idx = u.cursor.idx;
    if (idx == null || idx < 0) return;
    const x = u.data[0]?.[idx];
    if (x == null) return;
    const actionable = pane.slots.find((s) => s.def.actions?.length);
    if (!actionable) return;
    const action = actionable.def.actions![0]!;
    this.opts.hooks.onPointAction?.(action.id, { seriesKey: actionable.def.key, x });
  }

  /** Atomic coherent commit for one lane's phase: merge all → one render per
   *  pane. The VISIBLE lane drives autofit (its exact in-view extrema),
   *  skeleton, status, and the travel marker. PREFETCH lanes commit silently
   *  — they buffer data and push it to the panes for smooth panning, but their
   *  out-of-view extrema must NOT drive the viewport autofit, and they leave the
   *  skeleton/loading state alone. */
  private commitPhase(laneId: string, _phaseId: number, fragments: SeriesFragment[]): void {
    // Fragments were already merged into their tier in acceptFragment; commit
    // only RENDERS the now-complete frame from the active tier.
    if (laneId !== this.visibleLane) {
      // Prefetch: render to push buffered points to the panes (no extrema
      // override → autofit unchanged). Re-evaluate the skeleton — this lane may
      // be the last fetch in flight.
      this.renderActiveTier();
      this.updateSkeletonState();
      this.updateMinimapSketch();
      return;
    }

    // Provider-shipped exact extrema win over decimated points.
    const trueExtremaByPane = new Map<string, ExtentAccumulator>();
    let trueBaseline: number | null = null;
    for (const f of fragments) {
      const def = this.opts.recipe.series.find((s) => s.key === f.seriesKey);
      if (!def || isSpanRenderer(def.renderer)) continue; // spans never drive autofit
      if (f.trueExtrema) {
        let acc = trueExtremaByPane.get(def.paneId);
        if (!acc) trueExtremaByPane.set(def.paneId, (acc = new ExtentAccumulator()));
        acc.add(f.trueExtrema.min);
        acc.add(f.trueExtrema.max);
      }
      if (def.baseline && f.trueBaseline != null) trueBaseline = f.trueBaseline;
    }

    this.renderActiveTier(trueExtremaByPane, trueBaseline);
    this.lastReceivedVisibleFrom = this.visibleRequestFrom;
    this.updateSkeletonState();
    this.updateMinimapSketch();
    this.setStatus('idle');
  }

  /** Re-align the ACTIVE tier's stores onto the unified X timeline and ship
   *  to every pane (one setData + scale commit each). Shared by commit and by
   *  a tier switch that found the band already loaded (no fetch). */
  private renderActiveTier(
    trueExtremaByPane?: Map<string, ExtentAccumulator>,
    trueBaseline?: number | null,
  ): void {
    this.spanVersion++;
    for (const pane of this.panes) {
      // Don't draw into a collapsed pane (0 size): uPlot's convergeSize throws
      // on a zero-dimension layout, corrupting every plot. Redraws on reappear.
      if (this.hiddenPanes.has(pane.id)) continue;
      const aligned = alignStores(
        pane.slots.map((s) => ({ store: this.stores.get(s.def.key)!, column: s.column })),
      );
      const data = [aligned.xs, ...aligned.ys] as uPlot.AlignedData;
      this.fitPane(pane, trueExtremaByPane?.get(pane.id) ?? null, trueBaseline ?? null);
      const u = pane.plot;
      u.batch(() => {
        u.setData(data, false);
        this.applyScales(u, pane);
      });
    }
  }

  /**
   * Per-series clip to the LOADED x-ranges (skeleton coherence): line builders
   * connect across a not-yet-loaded gap (a straight shear between disjoint
   * regions); clipping the stroke to what's actually loaded makes the line stop
   * at the loaded edge instead. Grid is unaffected (drawn before series), so it
   * stays visible. Once coverage is complete the clip spans the whole plot area
   * (a no-op). Returns undefined when nothing is loaded — draw normally.
   */
  private loadedClip(u: uPlot, gaps?: ReadonlyArray<readonly [number, number]>): Path2D | undefined {
    const ivs = this.loaded.all;
    if (ivs.length === 0) return undefined;
    const { left, top, width, height } = u.bbox;
    const clip = new Path2D();
    if (gaps) {
      // Loaded strips minus break gaps (device px).
      const keep: Array<[number, number]> = [];
      for (const iv of ivs) {
        const x0 = Math.max(u.valToPos(iv.from, 'x', true), left);
        const x1 = Math.min(u.valToPos(iv.to, 'x', true), left + width);
        if (x1 > x0) keep.push([x0, x1]);
      }
      for (const [x0, x1] of subtractIntervals(keep, gaps)) clip.rect(x0, top, x1 - x0, height);
      return clip;
    }
    for (const iv of ivs) {
      const x0 = Math.max(u.valToPos(iv.from, 'x', true), left);
      const x1 = Math.min(u.valToPos(iv.to, 'x', true), left + width);
      if (x1 > x0) clip.rect(x0, top, x1 - x0, height);
    }
    return clip;
  }

  // ------------------------------------------------------------- spans

  /** uPlot series opts that render breaking spans as clip gaps. `nullGaps` are
   *  discarded: alignment nulls stay bridged. */
  private breakGapOpts(
    breaks: (u: uPlot) => Interval[],
    mode: 'linear' | 'stepped',
  ): Pick<uPlot.Series, 'spanGaps' | 'gaps'> {
    return {
      spanGaps: false,
      gaps: (u: uPlot, sidx: number) => {
        const brk = breaks(u);
        if (brk.length === 0) return [];
        // Stepped: hide the riser at the first sample after the break.
        const pad =
          mode === 'stepped' ? ((u.series[sidx]?.width ?? 1) * (window.devicePixelRatio || 1)) / 2 : 0;
        return breakGapsPx(
          u.data[0] as ArrayLike<number>,
          u.data[sidx] as ArrayLike<number | null>,
          brk,
          (t) => u.valToPos(t, 'x', true),
          mode,
          pad,
        );
      },
    };
  }

  /** Break intervals (UTC ms) over a pane at its current zoom; cached per draw
   *  state. Scans one viewport beyond each edge so off-screen breaks still
   *  segment curves consistently. */
  private paneBreaks(u: uPlot, paneId: string, defs: SeriesDef[]): Interval[] {
    const xMin = u.scales['x']?.min;
    const xMax = u.scales['x']?.max;
    if (xMin == null || xMax == null || !(xMax > xMin)) return [];
    const sig = `${this.spanVersion}|${xMin}|${xMax}|${u.bbox.width}`;
    const hit = this.breakCache.get(paneId);
    if (hit?.sig === sig) return hit.breaks;
    const span = xMax - xMin;
    const toCss = (t: number) => u.valToPos(t, 'x');
    const all: Interval[] = [];
    for (const def of defs) {
      if (!hasBreakingCategory(def)) continue;
      const store = this.stores.get(def.key);
      if (!store?.length) continue;
      const spans = spansInRange(store, def, xMin - span, xMax + span).filter((sp) =>
        this.spanVisible(def, sp.cat),
      );
      all.push(...breakIntervals(spans, (c) => def.categories?.[c], toCss));
    }
    const breaks = unionIntervals(all);
    this.breakCache.set(paneId, { sig, breaks });
    return breaks;
  }

  private spanVisible(def: SeriesDef, cat: number): boolean {
    return !this.hiddenSpans.has(def.key) && !this.hiddenSpans.has(`${def.key}#${cat}`);
  }

  /** Topmost visible pane a span series covers — the one that draws its labels. */
  private spanLabelPane(def: SeriesDef): string | undefined {
    const ids = this.opts.recipe.panes.map((p) => p.id);
    return spanPaneIds(def, ids).find((id) => !this.hiddenPanes.has(id));
  }

  /** Apply a span series (`key`) or category (`key#ordinal`) visibility.
   *  Returns false when `key` isn't a span key. */
  private applySpanVisibility(key: string, visible: boolean): boolean {
    let def = this.spanDefs.find((d) => d.key === key);
    const m = def ? null : /^(.*)#(\d+)$/.exec(key);
    if (m) {
      def = this.spanDefs.find((d) => d.key === m[1]);
      if (def && Number(m[2]) >= (def.categories?.length ?? 0)) def = undefined;
    }
    if (!def) return false;
    const perCategory = (def.categories?.length ?? 0) > 1 && !def.excludeFromLegend;
    const keys =
      key === def.key && perCategory ? def.categories!.map((_, i) => `${def.key}#${i}`) : [key];
    for (const k of keys) {
      if (visible) this.hiddenSpans.delete(k);
      else this.hiddenSpans.add(k);
    }
    this.spanVersion++;
    const rebuild = hasBreakingCategory(def); // breaks feed path building
    for (const pane of this.panes) {
      if (this.hiddenPanes.has(pane.id) || !pane.spanDefs.includes(def)) continue;
      pane.plot.redraw(rebuild, false);
    }
    return true;
  }

  /** Desaturate AND lighten the whole stack to a grey "skeleton" while the
   *  viewport isn't fully loaded — grayscale plus a 0.5 alpha multiply so it
   *  obviously reads as provisional; snap back to colour (CSS-transitioned)
   *  once it is. */
  /** Any lane of the current frame still loading — the viewport OR either
   *  prefetch pad. Keeps the skeleton up for the WHOLE frame so the pads don't
   *  blank out while only the middle has landed (a janky mid-grey island). */
  private get frameFetching(): boolean {
    return (
      this.coordinator.laneState(this.visibleLane) === 'fetching' ||
      this.coordinator.laneState(this.aheadLane) === 'fetching' ||
      this.coordinator.laneState(this.behindLane) === 'fetching'
    );
  }

  private updateSkeletonState(): void {
    // Skeleton iff a real VIEWPORT fetch is in flight — driven by lane state,
    // NOT missing(visible). The latter is evaluated against the OUTGOING tier at
    // gesture time, so a span change would false-grey even when the target tier
    // has it cached. Lane state means a cache-covered nav never greys; pads still
    // hold the skeleton up while the viewport loads (frameFetching).
    const incomplete =
      !this.frozen && this.frameHasVisibleFetch && this.frameFetching;
    const filter = incomplete ? 'grayscale(1) opacity(0.5)' : '';
    // Pane stack holds the chart, its axis labels, and the range readout, so one
    // filter fades them together.
    if (this.paneStack.style.filter !== filter) this.paneStack.style.filter = filter;
  }

  // -------------------------------------------------------- density tiers (#2)

  /** A fresh empty tier with a store per recipe series. */
  private makeTier(): Tier {
    const stores = new Map<string, SeriesStore>();
    for (const def of this.opts.recipe.series) {
      const spanEnd = def.renderer === 'vrect' ? spanColumns(def).end : undefined;
      stores.set(def.key, new SeriesStore(def.columns, spanEnd));
    }
    return { stores, loaded: new DisjointIntervalSet() };
  }

  /** Tier key = the power-of-2 band of `bucketMs` (so a 2× zoom change — the
   *  same threshold as the density upgrade — crosses bands). */
  private densityBand(bucketMs: number): number {
    const bars = Math.max(1, bucketMs / this.opts.barMs);
    return this.opts.barMs * 2 ** Math.max(0, Math.floor(Math.log2(bars)));
  }

  /** Tier key = line band, AND (when the recipe draws candles) the candle band.
   *  Candles fetch on a coarser nested grid than lines, so two views at the same
   *  line density (e.g. 1d & 1w, both full-res at a 30m cadence) still differ in
   *  candle density — keying on the line band alone put them in one tier, where
   *  the candle-density upgrade cleared the whole tier on every zoom-in. */
  private tierKey(lineBucketMs: number, candleBucketMs: number): string {
    const line = this.densityBand(lineBucketMs);
    return this.hasCandles ? `${line}:${this.densityBand(candleBucketMs)}` : `${line}`;
  }

  /** Make the tier for the (line, candle) density active, creating it on first
   *  visit and evicting the least-recently-used tier beyond MAX_TIERS. */
  private selectTier(lineBucketMs: number, candleBucketMs: number): void {
    const key = this.tierKey(lineBucketMs, candleBucketMs);
    let tier = this.tiers.get(key);
    if (!tier) {
      tier = this.makeTier();
      this.tiers.set(key, tier);
    }
    this.activeTier = tier;

    const i = this.tierLru.indexOf(key);
    if (i >= 0) this.tierLru.splice(i, 1);
    this.tierLru.unshift(key);
    while (this.tierLru.length > MAX_TIERS) {
      const evicted = this.tierLru.pop()!;
      if (evicted !== key) this.tiers.delete(evicted);
    }
  }

  /**
   * Scale-only refit (gesture preview / covered pan): no re-align, no
   * setData — bounded by a binary search + in-view scan per pane.
   */
  private refitVisible(): void {
    for (const pane of this.panes) {
      if (this.hiddenPanes.has(pane.id)) continue; // collapsed: skip
      this.fitPane(pane, null, null);
      this.applyScales(pane.plot, pane);
    }
  }

  /** Compute Y-autofit + percentage rebase for one pane. */
  private fitPane(
    pane: PaneRuntime,
    trueExtrema: ExtentAccumulator | null,
    trueBaseline: number | null,
  ): void {
    const visible = this.axis.visible;
    if (!pane.isStateLane && !pane.manualY) {
      const acc = trueExtrema ?? new ExtentAccumulator();
      for (const slot of pane.slots) {
        const store = this.stores.get(slot.def.key)!;
        const [lo, hi] = store.visibleIndexRange(visible);
        const col = store.columns[slot.column];
        if (col) acc.addRange(col, lo, hi);
      }
      // Scale margins as a fraction of pane height; deprecated yMarginFrac maps
      // to symmetric margins.
      const sm = this.opts.scaleMargins;
      const fit = fitY(acc, {
        log: pane.log,
        topFrac: sm?.top ?? this.opts.yMarginFrac ?? 0.05,
        bottomFrac: sm?.bottom ?? this.opts.yMarginFrac ?? 0.05,
      });
      if (fit) pane.yRange = fit;
    }

    // Percentage-origin rebase, independent of series visibility.
    if (pane.percent) {
      const baselineSlot = pane.slots.find(
        (s) => s.def.baseline && s.column === (s.def.baselineColumn ?? s.def.columns[0]),
      );
      if (baselineSlot) {
        const store = this.stores.get(baselineSlot.def.key)!;
        pane.percent.rebase(
          store.xs,
          store.columns[baselineSlot.column] ?? [],
          visible,
          trueBaseline,
        );
      }
    }
  }

  private applyScales(u: uPlot, pane: PaneRuntime): void {
    const visible = this.axis.visible;
    this.syncing = true;
    try {
      u.setScale('x', { min: visible.from, max: visible.to });
      u.setScale('y', { min: pane.yRange[0], max: pane.yRange[1] });
    } finally {
      this.syncing = false;
    }
  }

  // -------------------------------------------------------- minimap

  private requestOverview(): void {
    if (!this.minimap) return;
    const width = this.plotWidth();
    this.opts.hooks.requestOverview?.({ maxPoints: Math.max(200, width) });
  }

  /** Host delivers the full-extent overview series, plus any full-extent
   *  minimap marks (drawn beneath the fetched `minimapOverlay` events). */
  acceptOverview(xs: UtcMillis[], values: Array<number | null>, marks?: MinimapMark[]): void {
    if (this.destroyed || !this.minimap) return;
    this.overviewLoaded = true;
    this.lastOverview = { xs, values, marks: marks ? [...marks] : undefined };
    this.minimap.setOverview(xs, values);
    this.overviewMarks = marks ?? [];
    this.pushMinimapOverlay();
  }

  /**
   * Serialize the current viewport into a self-contained snapshot: recipe,
   * range, in-memory series data, and the minimap overview. Re-renders offline
   * with no backend (see snapshot.ts / NavigatorOptions.snapshot).
   */
  getSnapshot(): ChartSnapshot {
    const stores = [];
    for (const def of this.opts.recipe.series) {
      const s = this.stores.get(def.key);
      if (!s) continue;
      const columns: Record<string, Array<number | null>> = {};
      for (const c of Object.keys(s.columns)) columns[c] = [...s.columns[c]!];
      stores.push({ key: def.key, xs: [...s.xs], columns });
    }
    return {
      v: 1,
      recipe: this.opts.recipe,
      barMs: this.opts.barMs,
      extent: { ...this.axis.extent },
      visible: { ...this.axis.visible },
      percentMode: this.percentMode,
      hidden: this.legendModel?.items.filter((i) => !i.visible).map((i) => i.key) ?? [],
      stores,
      overview: this.lastOverview
        ? {
            xs: [...this.lastOverview.xs],
            values: [...this.lastOverview.values],
            ...(this.lastOverview.marks ? { marks: [...this.lastOverview.marks] } : {}),
          }
        : null,
    };
  }

  /** Rehydrate a frozen snapshot into the (already-built) panes, no fetch. */
  private loadSnapshot(snap: ChartSnapshot): void {
    let lo = Infinity;
    let hi = -Infinity;
    for (const sd of snap.stores) {
      const store = this.stores.get(sd.key);
      if (!store) continue;
      store.xs = sd.xs;
      store.columns = sd.columns;
      // Spans may start before the captured data; they don't define coverage.
      if (this.spanDefs.some((d) => d.key === sd.key)) continue;
      if (sd.xs.length) {
        lo = Math.min(lo, sd.xs[0]!);
        hi = Math.max(hi, sd.xs[sd.xs.length - 1]!);
      }
    }
    // Mark the captured span loaded so skeleton/clip don't fire inside it.
    if (lo <= hi) {
      this.loaded.add({ from: lo, to: hi + this.opts.barMs });
    }
    for (const key of snap.hidden) this.setSeriesVisible(key, false);
    if (snap.percentMode) this.setPercentMode(true);
    this.renderActiveTier();
    this.updateSkeletonState();
    if (snap.overview) this.acceptOverview(snap.overview.xs, snap.overview.values, snap.overview.marks);
  }

  /** Minimap sketch: until the full overview arrives, show the loaded
   *  baseline data (partial). */
  private updateMinimapSketch(): void {
    if (!this.minimap || this.overviewLoaded) return;
    const def =
      this.opts.recipe.series.find((s) => s.baseline) ??
      this.opts.recipe.series.find((s) => s.renderer === 'line');
    if (!def) return;
    const store = this.stores.get(def.key);
    if (!store) return;
    const column = def.baselineColumn ?? def.columns[def.columns.length - 1]!;
    this.minimap.setOverview([...store.xs], [...(store.columns[column] ?? [])]);
  }

  // ------------------------------------------------------------- hover

  /** Hide the hover label and cancel any pending detail fetch. */
  private hideTooltip(): void {
    this.tooltip.style.display = 'none';
    this.hoverAbort?.abort();
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverX = null;
  }

  /** Undo one box-zoom level, or reset to the default window if none remain
   *  (double-tap / double-click). */
  private popZoom(): void {
    const prev = this.zoomStack.pop();
    const target = prev ?? {
      from: this.opts.extent.to - 1000 * this.opts.barMs,
      to: this.opts.extent.to,
    };
    this.axis.propose(target, 'navigate');
  }

  /**
   * Long-press toggle of the hover legend. On a trackpad/mouse the legend
   * already follows the cursor (live hover), so this HIDES it (and it stays
   * hidden as the cursor moves) / re-SHOWS it. On touch there is no live
   * hover, so it PINS the legend at the point / clears it. Either way the
   * render is locked first so the lazy-detail round-trip still lands.
   */
  private toggleHoverLegend(clientX: number, clientY: number, isTouch: boolean): void {
    if (isTouch) {
      if (this.hoverState === 'pinned') {
        this.hoverState = 'live';
        this.hideTooltip();
        return;
      }
      this.hoverState = 'pinned'; // lock before the async render
      this.renderHoverAtPoint(clientX, clientY);
      return;
    }
    // trackpad / mouse: live-hover ↔ hidden
    if (this.hoverState === 'hidden') {
      this.hoverState = 'live';
      this.renderHoverAtPoint(clientX, clientY); // show now; cursor-move keeps it live
    } else {
      this.hoverState = 'hidden';
      this.hideTooltip();
    }
  }

  /** Render the hover legend at a screen point (long-press entry). */
  private renderHoverAtPoint(clientX: number, clientY: number): void {
    const pane =
      this.panes.find((p) => {
        const r = p.plot.over.getBoundingClientRect();
        return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
      }) ?? this.panes[0];
    if (!pane) return;
    const r = pane.plot.over.getBoundingClientRect();
    const left = clientX - r.left;
    const top = clientY - r.top;
    // posToVal gives a continuous x; renderHover snaps it to the nearest sample.
    const t = pane.plot.posToVal(left, 'x');
    this.renderHover(pane, t, left, top, t);
  }

  /** Snap a cursor x-pixel to the nearest sample on the primary pane's grid.
   *  Negative `left` is uPlot's off-plot sentinel (hide) — pass it through.
   *  Panes share the x scale and width, so the reference pixel is interchangeable
   *  and the snapped line stays aligned across every stacked pane. */
  private snapCursorLeft(u: uPlot, left: number): number {
    if (left < 0) return left;
    const ref = this.panes[0]?.plot ?? u;
    const xs = ref.data?.[0];
    if (!xs || xs.length === 0) return left;
    const snapped = xs[ref.posToIdx(left)];
    return snapped == null ? left : u.valToPos(snapped, 'x');
  }

  private onCursor(u: uPlot, pane: PaneRuntime): void {
    if (this.hoverState === 'pinned') return; // long-press pinned — leave it
    if (this.hoverState === 'hidden') {
      // long-press suppressed the legend — keep it gone as the cursor moves
      if (this.tooltip.style.display !== 'none') this.hideTooltip();
      return;
    }
    if (this.gestureActive) {
      // dragging: the cursor still moves, but hover chrome stays hidden
      if (this.tooltip.style.display !== 'none') this.hideTooltip();
      return;
    }
    const { idx, left, top } = u.cursor;
    if (idx == null || idx < 0 || left == null || left < 0) {
      this.hideTooltip();
      return;
    }
    const x = u.data[0]?.[idx];
    if (x == null) return;
    const raw = this.rawPointer;
    this.renderHover(pane, x, left, top ?? 0, raw ? raw.u.posToVal(raw.left, 'x') : undefined);
  }

  /** Build and show the grouped hover legend for a value `x` at a pane
   *  position. Shared by live hover (onCursor) and the long-press pin.
   *  `rawX` is the unsnapped cursor time, for span/vline rows. */
  private renderHover(
    pane: PaneRuntime,
    x: number,
    left: number,
    top: number,
    rawX?: number,
  ): void {
    this.hoverX = x;
    this.hoverPos = { pane, left, top };
    this.hoverSig = '';

    // Values at the nearest timestamp across ALL panes — one row per series,
    // grouped under the recipe's legend groups with recipe-defined templates.
    const entries: TooltipEntry[] = [
      { text: new Date(x).toISOString().replace('T', ' ').slice(0, 19) + ' UTC', header: true },
    ];
    const grouped = new Map<string, TooltipEntry[]>();
    for (const p of this.panes) {
      const data = p.plot.data;
      const pIdx = indexOfX(data[0] as ArrayLike<number>, x);
      if (pIdx < 0) continue;
      const stateNames = this.opts.recipe.panes.find((pd) => pd.id === p.id)?.stateNames;
      const seen = new Set<string>();
      for (let si = 0; si < p.slots.length; si++) {
        const s = p.slots[si]!;
        if (seen.has(s.def.key)) continue; // one row per series, not per slot
        if (s.def.excludeFromLegend) continue; // visual-only overlay: no hover row
        if (p.plot.series[si + 1]?.show === false) continue;
        seen.add(s.def.key);

        // Primary value: candles read close; continuous series carry the last
        // sample forward across decimated gaps; markers read their exact row
        // only. Always resolved AT OR BEFORE the cursor time, never ahead.
        const primaryColumn =
          s.def.renderer === 'candlestick' ? 'close' : s.def.columns[0]!;
        const primarySlotIdx = p.slots.findIndex(
          (t) => t.def.key === s.def.key && t.column === primaryColumn,
        );
        const scan = s.def.renderer === 'markers' ? 0 : 32;
        const colData = data[
          (primarySlotIdx >= 0 ? primarySlotIdx : si) + 1
        ] as ArrayLike<number | null>;
        const vIdx = priorNonNullIdx(colData, pIdx, scan);
        if (vIdx < 0) continue;
        const v = colData[vIdx]!;

        const stateName =
          p.isStateLane && stateNames ? (stateNames[Math.round(v)] ?? String(v)) : null;
        // Anchor the hover context at the row the value came from (the scan may
        // land on a neighbor), so {x} and {col.*} describe THAT event.
        const xAt = (data[0] as ArrayLike<number>)[vIdx] ?? x;
        const store = this.stores.get(s.def.key)!;
        const rowIdx = indexOfX(store.xs, xAt);
        const ctx = {
          label: s.def.label,
          x: xAt,
          value: v,
          column: (name: string) =>
            rowIdx >= 0 ? (store.columns[name]?.[rowIdx] ?? null) : null,
          stateName,
        };
        const template =
          s.def.hoverTemplate ??
          (s.def.renderer === 'candlestick'
            ? '{label}  O:{col.open} H:{col.high} L:{col.low} C:{col.close}'
            : stateName != null
              ? '{label}: {state}'
              : '{label}: {value}');
        const rendered = renderHoverTemplate(template, ctx).split('\n');
        const rows: TooltipEntry[] = rendered.map((text, li) =>
          li === 0 ? { color: s.def.color, text } : { text, indent: true },
        );
        const groupKey = s.def.group ?? '';
        if (!grouped.has(groupKey)) grouped.set(groupKey, []);
        grouped.get(groupKey)!.push(...rows);
      }
    }
    const spanRefs: PointRef[] = [];
    if (this.spanDefs.length && rawX != null) {
      const rectT = spanHoverTime(pane.plot.data[0] as ArrayLike<number>, x, rawX);
      this.addSpanHoverRows(pane, rectT, rawX, grouped, spanRefs);
    }
    for (const [group, rows] of grouped) {
      if (group) entries.push({ text: group, group: true });
      entries.push(...rows);
    }

    // Tooltip renders ATOMICALLY: values + lazy detail in one update. While a
    // fetch is pending the previous tooltip stays; a per-point cache makes
    // revisits instant.
    const detailHook = this.opts.hooks.requestHoverDetail;
    if (!detailHook) {
      this.showTooltip(pane, left, top ?? 0, entries);
      return;
    }
    const slot = pane.slots[0];
    if (!slot) return;
    const ref: PointRef = { seriesKey: slot.def.key, x };
    if (spanRefs.length) {
      this.showWithDetails(entries, [ref, ...spanRefs], detailHook);
      return;
    }
    const cacheKey = `${ref.seriesKey}|${x}`;
    const cached = this.detailCache.get(cacheKey);
    if (cached !== undefined) {
      this.showTooltip(pane, left, top ?? 0, withDetail(entries, cached));
      return;
    }
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => {
      this.hoverAbort?.abort();
      const abort = (this.hoverAbort = new AbortController());
      detailHook(ref, abort.signal)
        .then((detail) => {
          if (abort.signal.aborted) return;
          this.rememberDetail(cacheKey, detail ?? '');
          if (this.hoverX !== x || this.hoverSig !== '' || !this.hoverPos) return; // superseded
          const { pane: hp, left: hl, top: ht } = this.hoverPos;
          this.showTooltip(hp, hl, ht, withDetail(entries, detail ?? ''));
        })
        .catch(() => {
          if (this.hoverX === x && this.hoverPos) {
            // degrade to values-only, still atomic
            const { pane: hp, left: hl, top: ht } = this.hoverPos;
            this.showTooltip(hp, hl, ht, entries);
          }
        });
    }, 80);
  }

  /** Hover rows for visible spans covering `rectT` and vlines within
   *  VLINE_HOVER_PX of the cursor time `t`; collects their detail refs (series
   *  key + start). */
  private addSpanHoverRows(
    pane: PaneRuntime,
    rectT: number,
    t: number,
    grouped: Map<string, TooltipEntry[]>,
    refs: PointRef[],
  ): void {
    const u = pane.plot;
    const xMin = u.scales['x']?.min;
    const xMax = u.scales['x']?.max;
    const cssW = u.bbox.width / (window.devicePixelRatio || 1);
    const tolMs = xMin != null && xMax != null && cssW > 0 ? (VLINE_HOVER_PX * (xMax - xMin)) / cssW : 0;
    for (const def of this.spanDefs) {
      if (def.excludeFromLegend) continue;
      const store = this.stores.get(def.key);
      if (!store?.length) continue;
      const hits =
        def.renderer === 'vrect'
          ? spansAt(store, def, rectT).map((sp) => ({ x: sp.start, cat: sp.cat, idx: sp.idx }))
          : linesNear(store, def, t, tolMs).map((l) => ({ x: l.t, cat: l.cat, idx: l.idx }));
      for (const h of hits) {
        if (!this.spanVisible(def, h.cat)) continue;
        const style = def.categories?.[h.cat];
        const ctx: HoverContext = {
          label: def.label,
          x: h.x,
          value: h.cat,
          column: (name) => store.columns[name]?.[h.idx] ?? null,
          category: style?.name ?? null,
        };
        const template = def.hoverTemplate ?? (style ? '{label}: {category}' : '{label}');
        const detailKey = `${def.key}|${h.x}`;
        const rows: TooltipEntry[] = renderHoverTemplate(template, ctx)
          .split('\n')
          .map((text, li) =>
            li === 0 ? { color: spanInkColor(def, style), text, detailKey } : { text, indent: true },
          );
        const groupKey = def.group ?? '';
        if (!grouped.has(groupKey)) grouped.set(groupKey, []);
        grouped.get(groupKey)!.push(...rows);
        refs.push({ seriesKey: def.key, x: h.x });
      }
    }
  }

  /** Atomic hover render with several lazy details (point + spans): shows once
   *  every detail is cached or fetched; each span's detail sits under its row. */
  private showWithDetails(
    entries: TooltipEntry[],
    refs: PointRef[],
    detailHook: NonNullable<NavigatorHooks['requestHoverDetail']>,
  ): void {
    const keys = refs.map((r) => `${r.seriesKey}|${r.x}`);
    const sig = keys.join(',');
    this.hoverSig = sig;
    const show = (details: string[]) => {
      if (!this.hoverPos) return;
      const { pane: hp, left: hl, top: ht } = this.hoverPos;
      this.showTooltip(hp, hl, ht, withDetails(entries, keys, details));
    };
    const cached = keys.map((k) => this.detailCache.get(k));
    if (cached.every((d) => d !== undefined)) {
      show(cached as string[]);
      return;
    }
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => {
      this.hoverAbort?.abort();
      const abort = (this.hoverAbort = new AbortController());
      void Promise.all(
        refs.map((r, i) =>
          cached[i] !== undefined
            ? cached[i]!
            : detailHook(r, abort.signal).then(
                (d) => {
                  if (!abort.signal.aborted) this.rememberDetail(keys[i]!, d ?? '');
                  return d ?? '';
                },
                () => '', // degrade to values-only, still atomic
              ),
        ),
      ).then((details) => {
        if (abort.signal.aborted || this.hoverSig !== sig) return; // superseded
        show(details);
      });
    }, 80);
  }

  private rememberDetail(key: string, detail: string): void {
    if (this.detailCache.size >= 500) {
      const first = this.detailCache.keys().next().value;
      if (first !== undefined) this.detailCache.delete(first);
    }
    this.detailCache.set(key, detail);
  }

  /** Render the frosted hover label: header line, color-bulleted series
   *  rows, muted detail lines — built with DOM nodes (no HTML injection). */
  private showTooltip(
    pane: PaneRuntime,
    left: number,
    top: number,
    entries: TooltipEntry[],
  ): void {
    const paneRect = pane.el.getBoundingClientRect();
    const rootRect = this.root.getBoundingClientRect();
    this.tooltip.replaceChildren(
      ...entries.map((e) => {
        const row = document.createElement('div');
        if (e.color) {
          const bullet = document.createElement('span');
          bullet.textContent = '● ';
          bullet.style.color = e.color;
          row.appendChild(bullet);
        }
        const text = document.createElement('span');
        text.textContent = e.text;
        if (e.header) row.style.cssText = 'font-weight:600;margin-bottom:2px;';
        if (e.group) row.style.cssText = 'font-weight:600;opacity:.7;margin-top:4px;';
        if (e.indent) row.style.cssText = 'padding-left:16px;opacity:.85;';
        if (e.muted)
          row.style.cssText = 'opacity:.62;font-size:11px;' + (e.indent ? 'padding-left:16px;' : '');
        row.appendChild(text);
        return row;
      }),
    );
    this.tooltip.style.display = 'block';

    // Keep the label in view: flip to the other side of the cursor on overflow,
    // then clamp to the root bounds.
    const cursorX = paneRect.left - rootRect.left + left;
    const cursorY = paneRect.top - rootRect.top + top;
    const w = this.tooltip.offsetWidth;
    const h = this.tooltip.offsetHeight;
    const maxX = this.root.clientWidth;
    const maxY = this.root.clientHeight;
    let tipLeft = cursorX + 16;
    if (tipLeft + w > maxX) tipLeft = cursorX - 16 - w;
    tipLeft = Math.max(0, Math.min(tipLeft, maxX - w));
    let tipTop = cursorY + 16;
    if (tipTop + h > maxY) tipTop = cursorY - 16 - h;
    tipTop = Math.max(0, Math.min(tipTop, maxY - h));
    this.tooltip.style.left = `${tipLeft}px`;
    this.tooltip.style.top = `${tipTop}px`;
  }

  // ------------------------------------------------------------------ misc

  setPercentMode(on: boolean): void {
    this.percentMode = on;
    // recalcAxes: label space changed, recompute splits (skip collapsed panes —
    // a 0-size redraw trips uPlot's convergeSize).
    for (const pane of this.panes) {
      if (!this.hiddenPanes.has(pane.id)) pane.plot.redraw(false, true);
    }
  }

  /** Host API: set visibility and reflect it in the legend strip. */
  setSeriesVisible(key: string, visible: boolean): void {
    this.applySeriesVisibility(key, visible);
    this.legendModel?.syncExternal(key, visible);
    // A multi-category span series' legend items are its categories.
    const def = this.spanDefs.find((d) => d.key === key);
    def?.categories?.forEach((_, i) => this.legendModel?.syncExternal(`${key}#${i}`, visible));
    this.legendStrip?.render();
  }

  /** Engine-only visibility apply (legend callback sink). */
  private applySeriesVisibility(key: string, visible: boolean): void {
    if (this.spanDefs.length && this.applySpanVisibility(key, visible)) return;
    for (const pane of this.panes) {
      pane.slots.forEach((slot, i) => {
        if (slot.def.key === key) pane.plot.setSeries(i + 1, { show: visible });
      });
    }
    // A pane whose last visible series went dark (or first one lit) collapses /
    // reappears. Coalesced via rAF so a group toggle relayouts the stack once.
    this.scheduleRelayout();
    // Percentage origin intentionally NOT recomputed here.
  }

  private scheduleRelayout(): void {
    cancelAnimationFrame(this.relayoutRaf);
    this.relayoutRaf = requestAnimationFrame(() => this.applyPaneVisibility());
  }

  /** True when any series slot in the pane is currently shown. */
  private isPaneVisible(pane: PaneRuntime): boolean {
    return pane.slots.some((_s, i) => pane.plot.series[i + 1]?.show !== false);
  }

  /** Collapse panes with no visible series, restore panes that regained one,
   *  and relayout + move the shared x-axis if the visible set changed. */
  private applyPaneVisibility(): void {
    if (this.destroyed) return;
    let changed = false;
    for (const pane of this.panes) {
      const visible = this.isPaneVisible(pane);
      if (!visible && !this.hiddenPanes.has(pane.id)) {
        this.hiddenPanes.add(pane.id);
        pane.el.style.display = 'none';
        changed = true;
      } else if (visible && this.hiddenPanes.has(pane.id)) {
        this.hiddenPanes.delete(pane.id);
        pane.el.style.display = '';
        changed = true;
      }
    }
    if (!changed) return;
    this.updateBottomAxis();
    this.resize();
    // Repopulate: a reappeared pane holds stale (or no) data and resize alone
    // doesn't re-feed it. renderActiveTier skips still-collapsed panes.
    this.renderActiveTier();
  }

  /** Reassign the shared time-axis labels to the bottom-most visible pane: it
   *  spends label height (+ ticks + primary font); every other pane collapses
   *  its x-axis to 0. uPlot re-reads these on the setSize in resize(). */
  private updateBottomAxis(): void {
    const panes = this.opts.recipe.panes;
    const bottom = [...panes].reverse().find((p) => !this.hiddenPanes.has(p.id));
    this.bottomVisiblePid = (bottom ?? panes[panes.length - 1]!).id;
    for (const pane of this.panes) {
      const isBottom = pane.id === this.bottomVisiblePid;
      const xax = pane.plot.axes[0]!;
      // uPlot normalises axis.size to a function at construction, so the runtime
      // value must be a function too (a raw number throws in convergeSize). Font
      // is already the primary face on every pane, so no runtime change.
      xax.size = isBottom ? bottomAxisSize : zeroAxisSize;
      if (xax.ticks) xax.ticks.show = isBottom;
    }
  }

  getVisible(): TimeRange {
    return this.axis.visible;
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.resizeRaf);
    cancelAnimationFrame(this.relayoutRaf);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverAbort?.abort();
    this.datePicker?.destroy();
    this.minimap?.destroy();
    this.legendStrip?.destroy();
    for (const p of this.panes) p.plot.destroy();
    this.root.innerHTML = '';
  }
}

interface TooltipEntry {
  text: string;
  color?: string;
  header?: boolean;
  muted?: boolean;
  /** Legend-group section header row. */
  group?: boolean;
  /** Continuation row of a multi-line template. */
  indent?: boolean;
  /** Span/vline row: its lazy detail is inserted after this row's block. */
  detailKey?: string;
}

/** Append the lazy-detail block as muted rows. */
function withDetail(entries: TooltipEntry[], detail: string): TooltipEntry[] {
  if (!detail) return entries;
  return [...entries, ...detail.split('\n').map((text) => ({ text, muted: true }))];
}

/** Insert per-span details (keys[1..]) after their rows and append the point
 *  detail (keys[0]) at the end. */
function withDetails(entries: TooltipEntry[], keys: string[], details: string[]): TooltipEntry[] {
  const byKey = new Map(keys.slice(1).map((k, i) => [k, details[i + 1] ?? '']));
  const out: TooltipEntry[] = [];
  let pending: string | undefined;
  const flush = () => {
    if (pending) out.push(...pending.split('\n').map((text) => ({ text, muted: true, indent: true })));
    pending = undefined;
  };
  for (const e of entries) {
    if (pending !== undefined && !e.indent) flush();
    out.push(e);
    if (e.detailKey && byKey.has(e.detailKey)) pending = byKey.get(e.detailKey);
  }
  flush();
  return withDetail(out, details[0] ?? '');
}

/** Exact-match index of x in a sorted timeline; nearest-left within one step
 *  as fallback (panes may quantize to nested grids, e.g. coarser candles). */
function indexOfX(xs: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo < xs.length && xs[lo] === x) return lo;
  return lo > 0 ? lo - 1 : -1;
}

/** Hover ring is drawn on stroked series (lines, bands, markers); candlesticks
 *  and state lanes get none. */
function isRingSeries(renderer: string | undefined): boolean {
  return renderer != null && renderer !== 'candlestick' && renderer !== 'state-bars';
}

/** Hover-dot colour = the series IDENTITY (def.color), falling back to its line
 *  stroke. (lineColor on event series is a muted connector, not the dot's hue.) */
function dotColor(def: { color?: string; lineColor?: string } | undefined): string {
  return def?.color ?? def?.lineColor ?? '#888';
}

/** Re-express a colour at a given alpha, format-safe: handles #rgb / #rrggbb
 *  (with optional alpha pair) and rgb()/rgba(). Naive string concat breaks on
 *  rgba() inputs — that produces a black border fallback on event dots. */
function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (c[0] === '#') {
    const short = c.length < 6;
    const r = parseInt(short ? c[1]! + c[1]! : c.slice(1, 3), 16);
    const g = parseInt(short ? c[2]! + c[2]! : c.slice(3, 5), 16);
    const b = parseInt(short ? c[3]! + c[3]! : c.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : c;
}

function formatNative(v: number | null | undefined): string {
  // uPlot axis filters may null-out splits before values() runs.
  if (v == null || !Number.isFinite(v)) return '';

  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}
