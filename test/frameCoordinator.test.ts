// F2/N4 — the coherent-frame barrier.
import { describe, expect, it } from 'vitest';
import { FrameCoordinator } from '../src/frameCoordinator';
import type { SeriesFragment } from '../src/types';

const frag = (phaseId: number, fragmentCount: number, seriesKey = 's'): SeriesFragment => ({
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
    const fc = new FrameCoordinator((id) => commits.push(id));
    const p = fc.beginPhase();
    expect(fc.accept(frag(p, 3, 'a'))).toBe('buffered');
    expect(fc.accept(frag(p, 3, 'c'))).toBe('buffered');
    expect(commits).toEqual([]);
    expect(fc.accept(frag(p, 3, 'b'))).toBe('committed');
    expect(commits).toEqual([p]);
  });

  it('a newer phase supersedes an incomplete prior phase', () => {
    const commits: number[] = [];
    const fc = new FrameCoordinator((id) => commits.push(id));
    const p1 = fc.beginPhase();
    fc.accept(frag(p1, 3, 'a'));
    const p2 = fc.beginPhase();
    expect(fc.accept(frag(p2, 2, 'a'))).toBe('superseded-prior');
    // stragglers from p1 are stale
    expect(fc.accept(frag(p1, 3, 'b'))).toBe('stale');
    expect(fc.accept(frag(p2, 2, 'b'))).toBe('committed');
    expect(commits).toEqual([p2]);
  });

  it('discards fragments at or below the committed phase', () => {
    const fc = new FrameCoordinator(() => {});
    const p1 = fc.beginPhase();
    fc.accept(frag(p1, 1));
    expect(fc.accept(frag(p1, 1))).toBe('stale');
  });

  it('commit delivers all fragments of the phase', () => {
    let delivered: SeriesFragment[] = [];
    const fc = new FrameCoordinator((_, frags) => (delivered = frags));
    const p = fc.beginPhase();
    fc.accept(frag(p, 2, 'x'));
    fc.accept(frag(p, 2, 'y'));
    expect(delivered.map((f) => f.seriesKey).sort()).toEqual(['x', 'y']);
  });

  it('rejects never-issued phase ids and inconsistent counts', () => {
    const fc = new FrameCoordinator(() => {});
    expect(() => fc.accept(frag(99, 1))).toThrow(/never issued/);
    const p = fc.beginPhase();
    fc.accept(frag(p, 3));
    expect(() => fc.accept(frag(p, 4))).toThrow(/inconsistent/);
    expect(() => fc.accept(frag(fc.beginPhase(), 0))).toThrow(/invalid fragmentCount/);
  });

  it('is deterministic: no timers involved in the commit decision', () => {
    // The commit fires synchronously inside accept() — verified by call order.
    const order: string[] = [];
    const fc = new FrameCoordinator(() => order.push('commit'));
    const p = fc.beginPhase();
    order.push('a1');
    fc.accept(frag(p, 2, 'a'));
    order.push('a2');
    fc.accept(frag(p, 2, 'b'));
    order.push('after');
    expect(order).toEqual(['a1', 'a2', 'commit', 'after']);
  });
});
