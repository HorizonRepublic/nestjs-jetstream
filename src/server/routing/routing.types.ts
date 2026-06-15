import type { Logger } from '@nestjs/common';
import type { JsMsg } from '@nats-io/jetstream';

import type { RpcContext } from '../../context';
import type { EventBus } from '../../hooks';
import type { Codec, HandlerStatus, StreamKind } from '../../interfaces';
import type { ConsumeKind, ResolvedOtelOptions, ServerEndpoint } from '../../otel';

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
  /** Resolved ack-extension interval in ms, or null when disabled. */
  readonly ackExtensionInterval: number | null;
  readonly capture: DeadLetterCapture | null;
}
