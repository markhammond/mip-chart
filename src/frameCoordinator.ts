// The coherent-navigation-frame barrier. Pure logic — no DOM, no engine.

import type { SeriesFragment } from './types';

export type AcceptResult = 'committed' | 'buffered' | 'stale' | 'superseded-prior';

/**
 * A lane's fetch lifecycle — a tiny per-lane state machine the host derives the
 * skeleton from:
 *  - `idle`     — never requested (no fetch ever issued on this lane);
 *  - `fetching` — the latest issued phase has not yet committed (in flight);
 *  - `settled`  — the latest issued phase has committed (data is current).
 * Supersession is implicit: re-issuing (beginPhase) moves a `settled`/`fetching`
 * lane back to `fetching` on the new phase, so an in-flight stale phase never
 * keeps a lane `fetching` once a newer one has settled.
 */
export type LaneState = 'idle' | 'fetching' | 'settled';

interface PendingPhase {
  phaseId: number;
  expected: number;
  fragments: SeriesFragment[];
}

/** One independent commit lane. */
interface Lane {
  /** Next phase id to hand out for this lane (monotonic). */
  nextPhaseId: number;
  /** Latest phase id handed out (0 = none issued) — the state-machine cursor. */
  requestedPhase: number;
  pending: PendingPhase | null;
  lastCommitted: number;
}

/**
 * Accumulates fragments per (lane, phase id) and commits implicitly once a
 * phase's declared fragment count is met. Lanes are INDEPENDENT: a newer phase
 * id supersedes any incomplete prior phase ON THE SAME LANE, and fragments
 * at/below a lane's committed phase are discarded — but a slow prefetch lane
 * never supersedes the visible lane and vice-versa. Each lane keeps its own
 * monotonic phase sequence and a fetch state (<see cref="LaneState"/>).
 * Deterministic: commit is triggered by the counter alone — no timers.
 */
export class FrameCoordinator {
  private readonly lanes = new Map<string, Lane>();

  constructor(
    private readonly commit: (
      laneId: string,
      phaseId: number,
      fragments: SeriesFragment[],
    ) => void,
  ) {}

  private lane(laneId: string): Lane {
    let lane = this.lanes.get(laneId);
    if (!lane) {
      lane = { nextPhaseId: 1, requestedPhase: 0, pending: null, lastCommitted: 0 };
      this.lanes.set(laneId, lane);
    }
    return lane;
  }

  /** Allocate the next phase id for a lane (monotonic within the lane) and move
   *  the lane to `fetching`. Does not create pending state — the first arriving
   *  fragment does. */
  beginPhase(laneId: string): number {
    const lane = this.lane(laneId);
    return (lane.requestedPhase = lane.nextPhaseId++);
  }

  /** Highest committed phase id on a lane (0 if none committed yet). */
  committedPhase(laneId: string): number {
    return this.lanes.get(laneId)?.lastCommitted ?? 0;
  }

  /** The lane's fetch state — `fetching` while its latest issued phase is still
   *  in flight, `settled` once that phase commits, `idle` if never issued. */
  laneState(laneId: string): LaneState {
    const lane = this.lanes.get(laneId);
    if (!lane || lane.requestedPhase === 0) return 'idle';
    return lane.requestedPhase > lane.lastCommitted ? 'fetching' : 'settled';
  }

  accept(fragment: SeriesFragment): AcceptResult {
    const { laneId, phaseId, fragmentCount } = fragment;
    const lane = this.lane(laneId);

    // At or below this lane's last commit is stale.
    if (phaseId <= lane.lastCommitted) return 'stale';
    if (phaseId >= lane.nextPhaseId) {
      throw new Error(
        `fragment phase ${phaseId} on lane ${laneId} was never issued ` +
          `(next ${lane.nextPhaseId})`,
      );
    }
    if (!Number.isInteger(fragmentCount) || fragmentCount < 1) {
      throw new Error(`invalid fragmentCount ${fragmentCount} for phase ${phaseId}`);
    }

    let superseded = false;
    if (lane.pending && phaseId < lane.pending.phaseId) return 'stale';
    if (!lane.pending || phaseId > lane.pending.phaseId) {
      superseded = lane.pending !== null;
      lane.pending = { phaseId, expected: fragmentCount, fragments: [] };
    }

    const pending = lane.pending;
    if (pending.expected !== fragmentCount) {
      throw new Error(
        `inconsistent fragmentCount for ${laneId} phase ${phaseId}: ` +
          `${fragmentCount} vs ${pending.expected}`,
      );
    }

    pending.fragments.push(fragment);

    if (pending.fragments.length === pending.expected) {
      lane.pending = null;
      lane.lastCommitted = phaseId;
      this.commit(laneId, phaseId, pending.fragments);
      return 'committed';
    }
    return superseded ? 'superseded-prior' : 'buffered';
  }

  /** True while the given lane has a partially received phase. */
  hasIncompletePhase(laneId: string): boolean {
    return this.lanes.get(laneId)?.pending != null;
  }
}
