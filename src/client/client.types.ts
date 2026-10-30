import type { WritePacket } from '@nestjs/microservices';

import type { MsgHdrs, NatsConnection } from '@nats-io/transport-node';

import type { ConnectionProvider } from '../connection';
import type { EventBus } from '../hooks';
import type { Codec, TransportHeaderOptions } from '../interfaces';
import type { ResolvedOtelOptions, ServerEndpoint } from '../otel';
import type { ClientReporter } from './client-reporter';
import type { RpcReplyInbox } from './rpc-reply-inbox';

/** Settles one pending RPC round-trip with its reply or error packet. */
export type RpcReplyCallback = (packet: WritePacket) => void;

/** Settles one pending RPC round-trip the caller stopped waiting for. */
export type RpcCancelCallback = () => void;

/** The slice of a JetStream publish ack the client inspects for dedup warnings. */
export interface PublishAckLike {
  readonly duplicate: boolean;
  readonly seq: number;
}

/** One `client.send()` call, resolved to the target subject. */
export interface RpcRequest {
  readonly subject: string;
  readonly data: unknown;
  readonly headers: Map<string, string> | null;
  readonly timeout: number | undefined;
  /** The pattern as the caller wrote it; metrics and hooks report this one. */
  readonly declaredPattern: string;
}

/** A JetStream-mode RPC request, correlated with its reply through the inbox. */
export interface JetStreamRpcRequest extends RpcRequest {
  readonly correlationId: string;
  readonly messageId?: string;
}

/** What the RPC dispatcher needs from the client that owns it. */
export interface RpcDispatcherHost {
  readonly connection: ConnectionProvider;
  readonly codec: Codec;
  readonly eventBus: EventBus;
  readonly reporter: ClientReporter;
  readonly inbox: RpcReplyInbox;
  readonly otel: ResolvedOtelOptions;
  readonly serverEndpoint: ServerEndpoint | null;
  readonly callerName: string;
  readonly defaultTimeout: number;
  /** True once `connect()` wired the connection, so publishes can skip it. */
  isReady(): boolean;
  connect(): Promise<NatsConnection>;
  buildHeaders(
    customHeaders: Map<string, string> | null,
    transport: TransportHeaderOptions,
  ): MsgHdrs;
}
