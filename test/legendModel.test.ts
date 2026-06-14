// Legend state machine (F6): item / group / isolate semantics.
import { describe, expect, it } from 'vitest';
import { LegendModel } from '../src/legendModel';

const make = () => {
  const events: Array<[string, boolean]> = [];
  const m = new LegendModel(
    [
      { key: 'candles', label: 'OHLC', color: '#1', group: 'Observables' },
      { key: 'vwap', label: 'VWAP', color: '#2', group: 'Observables' },
      { key: 'ema', label: 'EMA', color: '#3', group: 'Indicators' },
      { key: 'state', label: 'State', color: '#4', group: '' },
    ],
    (k, v) => events.push([k, v]),
  );
  return { m, events };
};

describe('LegendModel', () => {
  it('groups preserve declaration order', () => {
    const { m } = make();
    expect(m.groups).toEqual(['Observables', 'Indicators', '']);
  });

  it('toggle flips one item and emits once', () => {
    const { m, events } = make();
    m.toggle('vwap');
    expect(m.find('vwap')!.visible).toBe(false);
    m.toggle('vwap');
    expect(m.find('vwap')!.visible).toBe(true);
    expect(events).toEqual([['vwap', false], ['vwap', true]]);
  });

  it('toggleGroup hides all members when any is visible, then shows all', () => {
    const { m, events } = make();
    m.toggle('candles'); // one member already hidden
    events.length = 0;
    m.toggleGroup('Observables'); // any visible → hide all (only vwap emits)
    expect(events).toEqual([['vwap', false]]);
    m.toggleGroup('Observables'); // none visible → show all
    expect(m.itemsOf('Observables').every((i) => i.visible)).toBe(true);
  });

  it('isolate hides all others; isolating the sole visible restores all', () => {
    const { m } = make();
    m.isolate('ema');
    expect(m.items.map((i) => i.visible)).toEqual([false, false, true, false]);
    m.isolate('ema'); // "others" restore (§4.6)
    expect(m.items.every((i) => i.visible)).toBe(true);
  });

  it('syncExternal updates state without re-emitting', () => {
    const { m, events } = make();
    m.syncExternal('candles', false);
    expect(m.find('candles')!.visible).toBe(false);
    expect(events).toEqual([]);
  });

  it('initial hidden flag respected', () => {
    const m = new LegendModel(
      [{ key: 'a', label: 'A', color: '#5', group: '', visible: false }],
      () => {},
    );
    expect(m.find('a')!.visible).toBe(false);
  });
});
