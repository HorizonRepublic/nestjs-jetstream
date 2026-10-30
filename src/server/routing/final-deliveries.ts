import type { JsMsg } from '@nats-io/jetstream';

import type { FinalDeliveryCheck } from './routing.types';

/** A final delivery whose handler is running in this process. */
interface RunningDelivery {
  readonly settled: Promise<void>;
  /** When the handler counts as hung, in epoch ms. */
  readonly hungAt: number;
}

const keyOf = (stream: string, streamSequence: number): string => `${stream}:${streamSequence}`;

/**
 * Final deliveries whose handler is running in this process. The server gives
 * up on such a message once ack_wait runs out, yet the handler can still settle
 * it: a late ack or term is honored, and a late failure is dead-lettered by the
 * handler's own settlement. The advisory capture waits for it, up to the point
 * where the handler counts as hung.
 */
export class FinalDeliveries {
  private readonly running = new Map<string, RunningDelivery>();

  public constructor(private readonly isFinal: FinalDeliveryCheck) {}

  /**
   * Remember `msg` until `pending` settles, if this is its last delivery.
   * `hungAfterMs` is how long its handler may run before it counts as hung.
   */
  public track(msg: JsMsg, pending: Promise<void>, hungAfterMs: number): void {
    if (!this.isFinal(msg)) return;

    const key = keyOf(msg.info.stream, msg.info.streamSequence);
    const settled = pending.then(
      () => undefined,
      () => undefined,
    );
    const entry: RunningDelivery = { settled, hungAt: Date.now() + hungAfterMs };

    this.running.set(key, entry);
    void settled.then(() => {
      if (this.running.get(key) === entry) this.running.delete(key);
    });
  }

  /**
   * Wait for the handler of this message, if it runs here. Resolves `true`
   * once it settled, `false` once it counts as hung, and is `null` when no
   * handler of this message runs in this process.
   */
  public waitFor(stream: string, streamSequence: number): Promise<boolean> | null {
    const entry = this.running.get(keyOf(stream, streamSequence));

    if (entry === undefined) return null;

    const remaining = entry.hungAt - Date.now();

    if (remaining <= 0) return Promise.resolve(false);
    if (!Number.isFinite(remaining)) return entry.settled.then(() => true);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, remaining);
    });

    return Promise.race([entry.settled.then(() => true), hung]).finally(() => {
      clearTimeout(timer);
    });
  }
}
