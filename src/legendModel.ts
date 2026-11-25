// Legend state machine — pure, unit-tested. The DOM strip (legend.ts) renders
// it; visibility side effects flow through one callback to keep the % origin
// anchor decoupled from legend state.

export interface LegendItem {
  key: string; // series key
  label: string;
  color: string;
  /** CSS `background` for the swatch when it isn't a flat colour (span hatch). */
  swatch?: string;
  group: string; // '' = ungrouped
  visible: boolean;
}

export class LegendModel {
  readonly items: LegendItem[];

  constructor(
    items: Array<Omit<LegendItem, 'visible'> & { visible?: boolean }>,
    /** Single visibility sink (the navigator's setSeriesVisible). */
    private readonly onVisibility: (key: string, visible: boolean) => void,
  ) {
    this.items = items.map((i) => ({ ...i, visible: i.visible ?? true }));
  }

  get groups(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const i of this.items) {
      if (!seen.has(i.group)) {
        seen.add(i.group);
        out.push(i.group);
      }
    }
    return out;
  }

  itemsOf(group: string): LegendItem[] {
    return this.items.filter((i) => i.group === group);
  }

  find(key: string): LegendItem | undefined {
    return this.items.find((i) => i.key === key);
  }

  /** Click an item: toggle it. */
  toggle(key: string): void {
    const item = this.find(key);
    if (!item) return;
    this.set(item, !item.visible);
  }

  /** Click a group label: hide the group if any member visible, else show all. */
  toggleGroup(group: string): void {
    const members = this.itemsOf(group);
    if (members.length === 0) return;
    const anyVisible = members.some((i) => i.visible);
    for (const i of members) this.set(i, !anyVisible);
  }

  /**
   * Alt-click an item: isolate it (hide all others). Alt-click the sole
   * visible item again: restore everything ("others" toggle).
   */
  isolate(key: string): void {
    const item = this.find(key);
    if (!item) return;
    const isSoleVisible = item.visible && this.items.every((i) => i === item || !i.visible);
    if (isSoleVisible) {
      for (const i of this.items) this.set(i, true);
    } else {
      for (const i of this.items) this.set(i, i === item);
    }
  }

  /** External visibility change (host API) — keep the model in sync. */
  syncExternal(key: string, visible: boolean): void {
    const item = this.find(key);
    if (item) item.visible = visible; // no callback: caller already applied it.
  }

  private set(item: LegendItem, visible: boolean): void {
    if (item.visible === visible) return;
    item.visible = visible;
    this.onVisibility(item.key, visible);
  }
}
