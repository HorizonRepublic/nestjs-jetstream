import type { JsMsg } from '@nats-io/jetstream';

import type { FinalDeliveryCheck } from './routing.types';

/** A final delivery whose handler is running in this process. */
interface RunningDelivery {
  readonly settled: Promise<void>;
  /** When the handler counts as hung, in epoch ms. */
  readonly hungAt: number;
}

const keyOf = (stream: string, streamSequence: number, deliveryCount: number): string =>
  `${stream}:${streamSequence}:${deliveryCount}`;

/**
 * Final deliveries whose handler is running in this process. The server gives
 * up on such a message once ack_wait runs out, yet the handler can still settle
 * it: a late ack or term is honored, and a late failure is dead-lettered by the
 * handler's own settlement. The advisory capture waits for it, up to the point
 * where the handler counts as hung.
 */
export class FinalDeliveries {
  private readonly running = new Map<string, RunningDelivery>();
  /** Resolvers of the waits in progress; abandoning resolves them as hung. */
  private readonly waits = new Set<(settled: boolean) => void>();

  public constructor(private readonly isFinal: FinalDeliveryCheck) {}

  /**
   * Remember `msg` until `pending` settles, if this is its last delivery.
   * `hungAfterMs` is how long its handler may run before it counts as hung.
   */
  public track(msg: JsMsg, pending: Promise<void>, hungAfterMs: number): void {
    if (!this.isFinal(msg)) return;

    const { stream, streamSequence, deliveryCount } = msg.info;
    const key = keyOf(stream, streamSequence, deliveryCount);
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
   * Wait for the handler of this delivery, if it runs here. Resolves `true`
   * once it settled, `false` once it counts as hung or the wait is abandoned,
   * and is `null` when no handler of this delivery runs in this process.
   */
  public waitFor(
    stream: string,
    streamSequence: number,
    deliveryCount: number,
  ): Promise<boolean> | null {
    const entry = this.running.get(keyOf(stream, streamSequence, deliveryCount));

    if (entry === undefined) return null;

    const remaining = entry.hungAt - Date.now();

    if (remaining <= 0) return Promise.resolve(false);

    const { promise, resolve } = Promise.withResolvers<boolean>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (Number.isFinite(remaining)) {
      timer = setTimeout(() => {
        resolve(false);
      }, remaining);
      if (typeof timer.unref === 'function') timer.unref();
    }

    void entry.settled.then(() => {
      resolve(true);
    });
    this.waits.add(resolve);

    return promise.finally(() => {
      clearTimeout(timer);
      this.waits.delete(resolve);
    });
  }

  /**
   * Resolve every wait in progress as hung. The server sends each advisory
   * once, so a capture still waiting when the process stops would be lost.
   */
  public abandonWaits(): void {
    for (const resolve of this.waits) resolve(false);
    this.waits.clear();
  }
}
