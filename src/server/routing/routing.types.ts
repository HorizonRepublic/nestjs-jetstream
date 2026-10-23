import type { Logger } from '@nestjs/common';

import type { JsMsg } from '@nats-io/jetstream';
import type { MsgHdrs } from '@nats-io/transport-node';

import type { RpcContext } from '../../context';
import type { EventBus } from '../../hooks';
import type { Codec, HandlerStatus, StreamKind } from '../../interfaces';
import type { ConsumeKind, ResolvedOtelOptions, ServerEndpoint } from '../../otel';
import type { AckExtension } from '../../utils';
import type { DeadLetterCapture } from './dead-letter-capture';
import type { PatternRegistry } from './pattern-registry';

/** Routes one message; `undefined` means the whole flow completed synchronously. */
export type RouteFn = (msg: JsMsg) => Promise<void> | undefined;

/** Starts an ack-extension timer for a parked message; returns its stop function. */
export type ParkTimerFn = (msg: JsMsg) => (() => void) | null;

/** Narrow consume-kind tag emitted by the event router (no `Rpc` here). */
export type EventConsumeKind = Exclude<ConsumeKind, ConsumeKind.Rpc>;

/** Reports one handler completion to the event bus. */
export type HandlerReporter = (msg: JsMsg, startedAt: number, status: HandlerStatus) => void;

/** Settles routed messages: ack, nak, term, or dead-letter escalation. */
export interface Settlement {
  /**
   * Settle after a handler completed without throwing. Returns a Promise only
   * when retry() on the final delivery escalates to dead-letter handling; a
   * nak there would strand the message.
   */
  settleSuccess(msg: JsMsg, ctx: RpcContext, data: unknown): Promise<void> | undefined;
  /** Settle after a handler threw: dead-letter on the final delivery, nak otherwise. */
  settleFailure(msg: JsMsg, data: unknown, err: unknown): Promise<void>;
}

/**
 * Per-subscription routing context. Built once per stream subscription;
 * every pipeline closure reads from this frozen snapshot so the per-message
 * hot path never touches the router instance.
 */
export interface RoutePipelineContext {
  readonly kind: StreamKind;
  readonly spanKind: EventConsumeKind;
  readonly codec: Codec;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly patternRegistry: PatternRegistry;
  readonly otel: ResolvedOtelOptions;
  readonly serviceName: string;
  readonly serverEndpoint: ServerEndpoint | null;
  /** Resolved ack extension, or null when disabled. */
  readonly ackExtension: AckExtension | null;
  /** Delay before each redelivery, in ms; empty means nak immediately. */
  readonly retryDelays: readonly number[];
  readonly capture: DeadLetterCapture | null;
  /** How a schedule tick with no handler is settled; `null` outside the schedule stream. */
  readonly orphans: OrphanTickPolicy | null;
}

/**
 * A tick no handler takes may reach a replica that has the handler on a later
 * delivery, during a rollout. Only when every delivery is spent is the schedule
 * an orphan, and it is cancelled so it stops firing.
 */
export interface OrphanTickPolicy {
  /** Deliveries before a tick counts as an orphan. */
  maxDeliver(): number;
  readonly redeliverDelayMs: number;
  /** Cancel the schedule whose holder fired the tick, unless a newer replica wrote it. */
  cancelIfOrphaned(holderSubject: string): Promise<OrphanOutcome>;
}

/** What happened to a schedule whose tick no handler took. */
export enum OrphanOutcome {
  Cancelled = 'cancelled',
  /** Written after this replica started, so a newer replica owns it. */
  Newer = 'newer',
  /** Already cancelled, by another replica or an earlier tick. */
  Gone = 'gone',
}

/**
 * A message that ran out of deliveries: either the live delivery a handler
 * just failed, or one found in the stream after the server gave up on it.
 */
export interface DeadLetterSource {
  readonly subject: string;
  readonly data: Uint8Array;
  readonly headers: MsgHdrs | undefined;
  readonly stream: string;
  readonly streamSequence: number;
  readonly deliveryCount: number;
  readonly timestamp: Date;
  /** Take the message out of circulation once it has been captured. */
  release(reason: string): Promise<void>;
  /** Leave the message where it is after a capture failed. */
  retain(): void;
}

/** A durable consumer whose exhausted deliveries are captured from server advisories. */
export interface DeadLetterWatchTarget {
  readonly stream: string;
  readonly consumer: string;
}

/** The fields this transport reads from a `MAX_DELIVERIES` consumer advisory. */
export interface MaxDeliveriesAdvisory {
  readonly stream?: string;
  readonly consumer?: string;
  readonly stream_seq?: number;
  readonly deliveries?: number;
}
