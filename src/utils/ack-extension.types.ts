import type { JsMsg } from '@nats-io/jetstream';

/** Ack extension resolved for one consumer. */
export interface AckExtension {
  /** How often `msg.working()` is sent, in milliseconds. */
  readonly intervalMs: number;
  /** How long one message may be extended, in milliseconds; `Infinity` for no limit. */
  readonly maxDurationMs: number;
}

/** The part of a message the extension pool touches. */
export type AckExtensionTarget = Pick<JsMsg, 'subject' | 'working'>;
