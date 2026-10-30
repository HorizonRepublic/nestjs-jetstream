const ignore = (): void => undefined;

/**
 * Tracks handler work still running, so shutdown can let it settle before the
 * connection drains and its acks and replies can no longer go out.
 */
export class InFlightTracker {
  private readonly pending = new Set<Promise<void>>();

  /** Number of tracked units of work that have not settled yet. */
  public get size(): number {
    return this.pending.size;
  }

  /** Track `work` until it settles; its outcome is left to the caller. */
  public track(work: Promise<unknown>): void {
    const settled = work.then(ignore, ignore);

    this.pending.add(settled);
    void settled.then(() => {
      this.pending.delete(settled);
    });
  }

  /** Resolve once nothing tracked is running, including work started while waiting. */
  public async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
  }
}
