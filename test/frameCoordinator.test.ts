// F2/N4 — the coherent-frame barrier, now per-lane (independent lanes).
import { describe, expect, it } from 'vitest';
import { FrameCoordinator } from '../src/frameCoordinator';
import type { SeriesFragment } from '../src/types';

const V = 'visible';
const P = 'prefetch';

const frag = (
  phaseId: number,
  fragmentCount: number,
  seriesKey = 's',
  laneId = V,
): SeriesFragment => ({
  laneId,
  sampleIntervalMs: 0,
  phaseId,
  fragmentCount,
  seriesKey,
  range: { from: 0, to: 10 },
  xs: [1, 2],
  columns: { value: [1, 2] },
});

describe('FrameCoordinator', () => {
  it('commits exactly when the fragment count is met, regardless of order', () => {
    const commits: number[] = [];
    const fc = new FrameCoordinator((_ch, id) => commits.push(id));
    const p = fc.beginPhase(V);
    expect(fc.accept(frag(p, 3, 'a'))).toBe('buffered');
    expect(fc.accept(frag(p, 3, 'c'))).toBe('buffered');
    expect(commits).toEqual([]);
    expect(fc.accept(frag(p, 3, 'b'))).toBe('committed');
    expect(commits).toEqual([p]);
  });

  it('a newer phase supersedes an incomplete prior phase on the SAME lane', () => {
    const commits: number[] = [];
    const fc = new FrameCoordinator((_ch, id) => commits.push(id));
    const p1 = fc.beginPhase(V);
    fc.accept(frag(p1, 3, 'a'));
    const p2 = fc.beginPhase(V);
    expect(fc.accept(frag(p2, 2, 'a'))).toBe('superseded-prior');
    // stragglers from p1 are stale
    expect(fc.accept(frag(p1, 3, 'b'))).toBe('stale');
    expect(fc.accept(frag(p2, 2, 'b'))).toBe('committed');
    expect(commits).toEqual([p2]);
  });

  it('lanes are INDEPENDENT — a prefetch phase never supersedes the visible one', () => {
    const commits: Array<[string, number]> = [];
    const fc = new FrameCoordinator((ch, id) => commits.push([ch, id]));

    const v = fc.beginPhase(V); // visible phase id 1
    const p = fc.beginPhase(P); // prefetch phase id 1 (separate lane sequence)

    // Visible partially in; a prefetch phase arriving does NOT drop it.
    expect(fc.accept(frag(v, 2, 'a', V))).toBe('buffered');
    expect(fc.accept(frag(p, 1, 'a', P))).toBe('committed'); // prefetch commits alone
    expect(fc.accept(frag(v, 2, 'b', V))).toBe('committed'); // visible still completes
    expect(commits).toEqual([
      [P, p],
      [V, v],
    ]);
  });

  it('per-lane monotonic phase ids start at 1 for each new lane', () => {
    const fc = new FrameCoordinator(() => {});
    expect(fc.beginPhase(V)).toBe(1);
    expect(fc.beginPhase(V)).toBe(2);
    expect(fc.beginPhase(P)).toBe(1); // independent sequence
    expect(fc.committedPhase(V)).toBe(0);
  });

  it('discards fragments at or below the committed phase (per lane)', () => {
    const fc = new FrameCoordinator(() => {});
    const p1 = fc.beginPhase(V);
    fc.accept(frag(p1, 1));
    expect(fc.accept(frag(p1, 1))).toBe('stale');
  });

  it('exposes a per-lane fetch state machine: idle → fetching → settled', () => {
    const fc = new FrameCoordinator(() => {});
    expect(fc.laneState(V)).toBe('idle'); // never issued
    const p = fc.beginPhase(V);
    expect(fc.laneState(V)).toBe('fetching'); // issued, not committed
    expect(fc.laneState(P)).toBe('idle'); // a different lane is independent
    fc.accept(frag(p, 1, 's', V));
    expect(fc.laneState(V)).toBe('settled'); // latest phase committed

    // Re-issuing moves it back to fetching; a stale earlier phase can't settle it.
    const p2 = fc.beginPhase(V);
    expect(fc.laneState(V)).toBe('fetching');
    expect(fc.accept(frag(p, 1, 's', V))).toBe('stale');
    expect(fc.laneState(V)).toBe('fetching');
    fc.accept(frag(p2, 1, 's', V));
    expect(fc.laneState(V)).toBe('settled');
  });

  it('commit delivers all fragments of the phase with its lane id', () => {
    let deliveredLane = '';
    let delivered: SeriesFragment[] = [];
    const fc = new FrameCoordinator((ch, _id, frags) => {
      deliveredLane = ch;
      delivered = frags;
    });
    const p = fc.beginPhase(P);
    fc.accept(frag(p, 2, 'x', P));
    fc.accept(frag(p, 2, 'y', P));
    expect(deliveredLane).toBe(P);
    expect(delivered.map((f) => f.seriesKey).sort()).toEqual(['x', 'y']);
  });

  it('rejects never-issued phase ids and inconsistent counts', () => {
    const fc = new FrameCoordinator(() => {});
    expect(() => fc.accept(frag(99, 1))).toThrow(/never issued/);
    const p = fc.beginPhase(V);
    fc.accept(frag(p, 3));
    expect(() => fc.accept(frag(p, 4))).toThrow(/inconsistent/);
    expect(() => fc.accept(frag(fc.beginPhase(V), 0))).toThrow(/invalid fragmentCount/);
  });

  it('is deterministic: no timers involved in the commit decision', () => {
    const order: string[] = [];
    const fc = new FrameCoordinator(() => order.push('commit'));
    const p = fc.beginPhase(V);
    order.push('a1');
    fc.accept(frag(p, 2, 'a'));
    order.push('a2');
    fc.accept(frag(p, 2, 'b'));
    order.push('after');
    expect(order).toEqual(['a1', 'a2', 'commit', 'after']);
  });
});
