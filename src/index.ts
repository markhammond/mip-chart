// Public surface of the chart navigator (host-agnostic).
import 'uplot/dist/uPlot.min.css'; // emitted as dist/chart-navigator.css

export { ChartNavigator } from './chartNavigator';
export { buildStandaloneHtml } from './snapshot';
export type { ChartSnapshot } from './types';
export { TimeAxis, minVisibleSpanMs } from './timeAxis';
export type { NavigationCause, AxisListener } from './timeAxis';
export { Minimap } from './minimap';
export { FrameCoordinator } from './frameCoordinator';
export { DisjointIntervalSet } from './intervals';
export { SeriesStore, alignStores, lowerBound, nearestNonNull, nearestNonNullIdx, priorNonNullIdx } from './seriesStore';
export { ExtentAccumulator, fitY } from './autofit';
export { PercentOrigin } from './percentAxis';
export { niceStep, niceLinearSplits, niceLogSplits, nicePercentSplits } from './splits';
export { tvLadderCeil, tvLinearTicks, tvLogTicks, tvPercentTicks, TV_TICK_DENSITY } from './splits';
export { LegendModel } from './legendModel';
export type { LegendItem } from './legendModel';
export { stateColor, DEFAULT_STATE_COLORS } from './stateBars';
export { coalesceSpans, breakIntervals, breakGapsPx, spansAt, linesNear } from './spans';
export type { Span, VLine, Interval } from './spans';
export type {
  UtcMillis,
  TimeRange,
  ScaleKind,
  SeriesRenderer,
  PaneDef,
  SeriesDef,
  SpanStyle,
  SpanHatch,
  ViewRecipe,
  SeriesFragment,
  NavigationRequest,
  OverviewRequest,
  PointRef,
  PointAction,
  NavigatorHooks,
  NavigatorOptions,
} from './types';
export { tvTimeTicks } from './timeTicks';
export type { TimeTick, TimeTickOptions } from './timeTicks';
export { renderHoverTemplate, formatHoverNumber, formatHoverDate } from './hoverFormat';
export type { HoverContext } from './hoverFormat';
