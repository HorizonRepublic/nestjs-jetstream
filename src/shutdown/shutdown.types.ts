/** What the shutdown sequence needs from a transport strategy. */
export interface Stoppable {
  /** Stop taking new messages. */
  close(): void;
  /** Resolves once work that was already running when `close()` ran has settled. */
  whenIdle(): Promise<void>;
}
