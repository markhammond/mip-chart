// The coherent-navigation-frame barrier.
// Pure logic — no DOM, no engine — so it is unit-testable.

import type { SeriesFragment } from './types';

export type AcceptResult = 'committed' | 'buffered' | 'stale' | 'superseded-prior';

interface PendingPhase {
  phaseId: number;
  expected: number | null;
  fragments: SeriesFragment[];
}

/**
 * Accumulates fragments per phase id and commits implicitly once the phase's
 * declared fragment count is met. A newer phase id supersedes any incomplete
 * prior phase; fragments for already-committed or superseded phases are
 * discarded. Deterministic: commit is triggered by the counter alone — no
 * timers.
 */
export class FrameCoordinator {
  private nextPhaseId = 1;
  private pending: PendingPhase | null = null;
  private lastCommittedPhase = 0;

  constructor(
    private readonly commit: (phaseId: number, fragments: SeriesFragment[]) => void,
  ) {}

  /** Allocate the next phase id (monotonic). Does not create pending state —
   *  the first arriving fragment does. */
  beginPhase(): number {
    return this.nextPhaseId++;
  }

  /** Highest phase id handed out so far. */
  get currentPhase(): number {
    return this.nextPhaseId - 1;
  }

  get committedPhase(): number {
    return this.lastCommittedPhase;
  }

  accept(fragment: SeriesFragment): AcceptResult {
    const { phaseId, fragmentCount } = fragment;

    // Anything at or below the last committed phase — or below an in-flight
    // newer phase — is stale.
    if (phaseId <= this.lastCommittedPhase) return 'stale';
    if (phaseId > this.currentPhase) {
      throw new Error(
        `fragment phase ${phaseId} was never issued (current ${this.currentPhase})`,
      );
    }
    if (!Number.isInteger(fragmentCount) || fragmentCount < 1) {
      throw new Error(`invalid fragmentCount ${fragmentCount} for phase ${phaseId}`);
    }

    let superseded = false;
    if (this.pending && phaseId < this.pending.phaseId) return 'stale';
    if (!this.pending || phaseId > this.pending.phaseId) {
      superseded = this.pending !== null;
      this.pending = { phaseId, expected: fragmentCount, fragments: [] };
    }

    const pending = this.pending;
    if (pending.expected !== fragmentCount) {
      throw new Error(
        `inconsistent fragmentCount for phase ${phaseId}: ${fragmentCount} vs ${pending.expected}`,
      );
    }

    pending.fragments.push(fragment);

    if (pending.fragments.length === pending.expected) {
      this.pending = null;
      this.lastCommittedPhase = phaseId;
      this.commit(phaseId, pending.fragments);
      return 'committed';
    }
    return superseded ? 'superseded-prior' : 'buffered';
  }

  /** True while a phase is partially received. */
  get hasIncompletePhase(): boolean {
    return this.pending !== null;
  }
}
