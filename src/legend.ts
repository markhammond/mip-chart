// Legend strip for the whole pane stack, grouped per SeriesDef.group.
// Click = toggle item; click group label = toggle group; alt-click = isolate/restore.

import { LegendModel } from './legendModel';

export class LegendStrip {
  readonly el: HTMLElement;

  constructor(
    container: HTMLElement,
    private readonly model: LegendModel,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'vcn-legend';
    this.el.style.cssText =
      'display:flex;flex-wrap:wrap;gap:2px 18px;align-items:center;' +
      'padding:4px 8px;font:12px system-ui,sans-serif;user-select:none;';
    container.appendChild(this.el);
    this.render();
  }

  /** Re-render after any model change (cheap: tens of nodes). */
  render(): void {
    this.el.innerHTML = '';
    for (const group of this.model.groups) {
      const block = document.createElement('span');
      block.style.cssText = 'display:inline-flex;gap:10px;align-items:center;';

      if (group !== '') {
        // Dim the group label when all its series are hidden.
        const groupOff = this.model.itemsOf(group).every((i) => !i.visible);
        const head = document.createElement('span');
        head.textContent = group;
        head.style.cssText =
          `font-weight:600;cursor:pointer;opacity:${groupOff ? '.38' : '.85'};`;
        head.title = 'toggle group';
        head.addEventListener('click', () => {
          this.model.toggleGroup(group);
          this.render();
        });
        block.appendChild(head);
      }

      for (const item of this.model.itemsOf(group)) {
        const chip = document.createElement('span');
        chip.style.cssText =
          'display:inline-flex;gap:5px;align-items:center;cursor:pointer;' +
          (item.visible ? '' : 'opacity:.38;');
        chip.title = 'click: toggle · alt-click: isolate';

        const swatch = document.createElement('span');
        swatch.style.cssText =
          `width:10px;height:10px;border-radius:2px;background:${item.color};` +
          'display:inline-block;';
        if (item.swatch) {
          swatch.style.background = item.swatch;
          swatch.style.boxShadow = 'inset 0 0 0 1px rgba(0,0,0,.12)';
        }
        const label = document.createElement('span');
        label.textContent = item.label;

        chip.append(swatch, label);
        chip.addEventListener('click', (e) => {
          if (e.altKey) this.model.isolate(item.key);
          else this.model.toggle(item.key);
          this.render();
        });
        block.appendChild(chip);
      }
      this.el.appendChild(block);
    }
  }

  destroy(): void {
    this.el.remove();
  }
}
