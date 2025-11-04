import { Injectable, Logger } from '@nestjs/common';
import { headers, JsMsg, JSONCodec } from 'nats';
import {
  catchError,
  EMPTY,
  from,
  map,
  mergeMap,
  Observable,
  of,
  switchMap,
  take,
  tap,
  timeout,
  TimeoutError,
} from 'rxjs';

import { ConnectionProvider } from '../../common/connection.provider';
import { PatternRegistry } from '../../common/pattern-registry';
import { RpcContext } from '../../common/rpc.context';
import { JetstreamHeaders } from '../../enum';

import { MessageProvider } from './message.provider';

/**
 * MessageRoutingProvider is the runtime layer that:
 * - subscribes on messages from JetStream
 * - finds the matching NestJS handler
 * - executes it under the correct delivery semantics
 * - resolves the message in JetStream via ack/nak/term
 * - (for RPC) publishes a response back to the caller.
 *
 * There are 2 delivery models in this transport:
 *
 * 1. RPC (Command channel)
 *    This is basically "I want a result", similar to HTTP via a broker.
 *    Flow:
 *    - The client publishes a command to a JetStream subject (not a direct request-reply call).
 *      The message includes:
 *        - ReplyTo header: where to publish the response
 *        - CorrelationId header: how the client will match the response
 *    - A service instance consumes the command from JetStream using a consumer (work queue style).
 *    - The handler runs.
 *    - The server publishes either a success response or an error response to ReplyTo,
 *      including the same CorrelationId.
 *
 *    After handler execution, we settle the original JetStream message in one
 *    of three ways:
 *
 *    - Success:
 *        1) handler produced a value
 *        2) we encode it and publish it to ReplyTo with CorrelationId
 *        3) msg.ack() - JetStream now considers this command processed.
 *
 *    - Handler error (business error, validation error, etc.):
 *        1) handler threw (not a TimeoutError)
 *        2) we encode that error and publish it to ReplyTo with CorrelationId
 *        3) msg.term() - we tell JetStream "this message is done, do not redeliver".
 *
 *      Why term() and not nak() here:
 *      - nak() would ask JetStream to redeliver the same command to another pod
 *      - that could re-run a non-idempotent business action ("charge card", "move inventory", etc.)
 *      - we explicitly do NOT want automatic retries for commands
 *      - instead we complete it with term() and let the client decide if it wants to retry.
 *
 *    - Timeout:
 *        1) handler didn't emit within the allowed window (e.g., 3 minutes)
 *        2) we do NOT publish anything to ReplyTo
 *        3) msg.term() with a timeout reason.
 *
 *      In this case the client will hit its own timeout as well and decide what to do next,
 *      exactly like a slow HTTP request where you never got a response.
 *
 *    Important difference from classic NATS request/reply:
 *    - We do NOT treat RPC as "send a request to an inbox and wait".
 *    - We treat RPC as "enqueue a command in JetStream (work queue semantics),
 *      then get the result asynchronously via a shared inbox channel."
 *    - The command itself is load-balanced and flow-controlled by JetStream
 *      (ack_wait, max_ack_pending, max_deliver, queue groups, etc.)
 *    - The reply uses the lightweight inbox.
 *
 *    This means:
 *    - you get horizontal scaling for command handlers
 *    - you get control over delivery guarantees
 *    - you keep request/response semantics for the caller
 *    - retries are explicit and owned by the caller, not by the broker.
 *
 *
 * 2. Event (Event channel)
 *    This is "fire-and-forget": something happened, other services may react.
 *    We are not trying to provide a response to the publisher.
 *
 *    Flow:
 *    - We receive an event message from JetStream.
 *    - We find the handler for that subject.
 *    - We start executing the handler.
 *    - As soon as the handler actually begins processing, we ack() the message.
 *
 *    The important nuance is WHEN we ack():
 *
 *    - We interpret "handler has started" as: the handler produces its first emission.
 *      Even if that's just `undefined`, we treat that first next() as a signal:
 *      "I accept responsibility for this event".
 *
 *    - Right after that first emission, we do msg.ack() and mark this event as handled
 *      from JetStream’s point of view.
 *
 *    - We do NOT wait for the entire business logic to finish. Long-running work
 *      (sending emails, updating projections, etc.) continues after we've acked.
 *
 *    Error handling logic for events:
 *
 *    - If the handler throws BEFORE it ever emits:
 *        -> we have not acked yet
 *        -> we msg.nak()
 *        -> JetStream is allowed to redeliver this event to another pod
 *        This means: "we failed to even start, maybe someone else can take it".
 *
 *    - If the handler throws AFTER we've already acked:
 *        -> we do NOT nak()
 *        -> we do NOT ask for redelivery
 *        -> it's now the handler's (business logic's) problem to compensate/retry.
 *
 *    This gives you "at-most-once after acceptance":
 *    - Either no one managed to start (we nak and someone else might retry)
 *    - Or one consumer said "I'm on it" (ack), and then it's that consumer's
 *      responsibility to finish or compensate.
 *
 *    Handler contract:
 *    - The handler is expected to emit at least once (even `void`) to signal
 *      "I have started".
 *    - If it never emits and also doesn't throw, we will never ack, so JetStream
 *      will eventually consider this unacked and redeliver based on ack_wait.
 *
 *    Where this model works well:
 *    - cache invalidation
 *    - projections / denormalized views
 *    - analytics / audit trails
 *    - notifications / fan-out.
 *
 *    Where this model is NOT appropriate:
 *    - critical state transitions (financial posting, order finalization, stock decrement, etc.)
 *      If you absolutely cannot afford to lose or duplicate the side effect,
 *      do not ship it as a "fire-and-forget event".
 *      Use RPC (so the caller gets an explicit result and can retry),
 *      or build a dedicated idempotent pipeline on top of raw NATS/JetStream.
 *
 *
 * Concurrency and backpressure:
 *
 * - We consume both commands$ (RPC) and events$ (Event) using mergeMap().
 * - mergeMap() here is intentionally unbounded, which means multiple messages
 *   can be processed in parallel.
 * - This favors throughput and low latency.
 * - If you need strict backpressure or a concurrency cap, wrap this layer
 *   and provide your own mergeMap(..., concurrency).
 *
 *
 * Delivery semantics summary:
 *
 * - RPC:
 *   success  -> publish response -> ack()
 *   handler error -> publish error -> term()
 *   timeout -> no response -> term()
 *   nak() is not used, because we do not want automatic replays of possibly
 *   non-idempotent business actions.
 *
 * - Event:
 *   handler starts -> ack() immediately
 *   handler fails before start -> nak()
 *   handler fails after ack    -> we do nothing transport-level,
 *                                 it's now up to the business code.
 */
@Injectable()
export class MessageRoutingProvider {
  private readonly codec = JSONCodec(); // JSON codec for (de)serializing payloads
  private readonly logger = new Logger(MessageRoutingProvider.name);

  /**
   * Wire up streams of incoming messages.
   *
   * MessageProvider.commands$:
   * Stream of JsMsg from the "command" (RPC) consumer.
   *
   * MessageProvider.events$:
   * Stream of JsMsg from the "event" (fire-and-forget) consumer.
   *
   * We use mergeMap() so multiple messages can be processed at once.
   * If a single message handler throws, we log it and resume.
   *
   * PatternRegistry:
   * Maps message subjects to NestJS handlers registered via @MessagePattern / @EventPattern.
   *
   * ConnectionProvider:
   * Exposes the active NATS connection (nc) as an observable,
   * used to publish RPC replies back to the caller's inbox.
   *
   * @param messageProvider
   * @param patternRegistry
   * @param connectionProvider
   */
  public constructor(
    private readonly connectionProvider: ConnectionProvider,
    private readonly messageProvider: MessageProvider,
    private readonly patternRegistry: PatternRegistry,
  ) {
    this.messageProvider.commands$
      .pipe(
        mergeMap((msg) => this.handleRpc(msg)),
        catchError((error, caught) => {
          this.logger.error('Error in RPC handler:', error);

          return caught;
        }),
      )
      .subscribe();

    this.messageProvider.events$
      .pipe(
        mergeMap((msg) => this.handleEvent(msg)),
        catchError((error, caught) => {
          this.logger.error('Error in event handler:', error);

          return caught;
        }),
      )
      .subscribe();
  }

  /**
   * Handle an RPC-style command message.
   *
   * Steps:
   * 1. Find the handler for this subject.
   * - If no handler exists, we term() immediately because nobody can process it.
   *
   * 2. Validate required headers:
   * - ReplyTo: the subject where we should publish the response
   * - CorrelationId: allows the client to match the response with its original call.
   *
   * If either is missing:
   * - we term() the message (not nak)
   * - reason: redelivery won't help, it's already malformed.
   *
   * 3. Execute the handler:
   * The handler may return:
   * - T
   * - Promise<T>
   * - Observable<T>
   * - Promise<Observable<T>>.
   *
   * We normalize with from(...).switchMap(from(...)).take(1)
   * so we always deal with a single first value (RPC = single reply).
   *
   * 4. Timeout:
   * If the handler does not produce a value within 3 minutes:
   * - msg.term("timeout")
   * - we do NOT publish anything to ReplyTo
   * - the client should timeout on its side and decide on retry logic.
   *
   * 5. Error (non-timeout):
   * If the handler throws:
   * - we serialize that error
   * - we publish it to ReplyTo with the same CorrelationId
   * - we msg.term() to tell JetStream "this command is finished, don't redeliver".
   *
   * 6. Success:
   * If the handler returns a value:
   * - serialize and publish that value to ReplyTo with CorrelationId
   * - msg.ack() to mark the command as processed.
   *
   * Ack vs term in RPC:
   * - ack() means "successfully processed and responded"
   * - term() means "finished with failure/timeout; do not redeliver".
   *
   * Nak() is intentionally never used for RPC commands, because re-running
   * the same command on another pod can cause unsafe duplicate side effects.
   *
   * @param msg
   */
  protected handleRpc(msg: JsMsg): Observable<void> {
    // 1. Resolve handler
    const handler = this.patternRegistry.getHandler(msg.subject);

    if (!handler) {
      msg.term(`No handler found for RPC subject: ${msg.subject}`);
      this.logger.error(`No handler found for subject: ${msg.subject}`);

      return of(void 0);
    }

    // 2. Required headers
    const correlationId = msg.headers?.get(JetstreamHeaders.CorrelationId);
    const replyTo = msg.headers?.get(JetstreamHeaders.ReplyTo);

    if (!replyTo) {
      msg.term(`Reply-to header is missing in RPC message: ${msg.subject}`);
      this.logger.error(`Reply-to header is missing in RPC message: ${msg.subject}`);

      return of(void 0);
    }

    if (!correlationId) {
      msg.term(`Correlation-id header is missing in RPC message: ${msg.subject}`);
      this.logger.error(`Correlation-id header is missing in RPC message: ${msg.subject}`);

      return of(void 0);
    }

    // 3. Decode payload and build execution context
    const ctx = new RpcContext([msg]);

    let data: unknown;

    try {
      data = this.codec.decode(msg.data);
    } catch (error) {
      this.logger.error(`Failed to decode RPC message for ${msg.subject}:`, error);
      msg.term('Invalid message payload');

      return of(void 0);
    }

    const hdrs = headers();
    const handlerResult = handler(data, ctx);

    // Propagate correlation ID back to the caller
    hdrs.set(JetstreamHeaders.CorrelationId, correlationId);

    // 4-6. Run handler, handle timeout/error/success, and respond
    return this.connectionProvider.nc.pipe(
      switchMap((nc) =>
        from(handlerResult).pipe(
          // unwrap Promise<Observable<T>> | Promise<T> | Observable<T> | T
          switchMap((inner) => from(inner)),
          take(1),

          // safety net: don't block forever
          timeout(3 * 60 * 1000),

          // error branch (timeout OR handler error)
          catchError((error: unknown) => {
            if (error instanceof TimeoutError) {
              // handler took too long, no response back to caller
              this.logger.error(`Handler timeout for ${msg.subject} (3 minutes)`);
              msg.term('Handler timeout: exceeded 3 minutes');

              return EMPTY;
            }

            // handler threw a business/validation/internal error
            // we still publish a structured error to the caller
            const rpcError = this.codec.encode(error);

            nc.publish(replyTo, rpcError, { headers: hdrs });
            msg.term(`Handler ${msg.subject} responded with error`);

            return EMPTY;
          }),

          // success branch
          switchMap((actualResponse) => {
            const encodedResponse = this.codec.encode(actualResponse);

            nc.publish(replyTo, encodedResponse, { headers: hdrs });
            msg.ack();

            return of(void 0);
          }),
        ),
      ),
    );
  }

  /**
   * Handle an Event-style message (fire-and-forget).
   *
   * This model is optimized for fan-out / side effects, not for strict state transitions.
   * Examples:
   * - cache invalidation
   * - projection updates / denormalization
   * - analytics / audit trails
   * - notifications.
   *
   * It is NOT suited for critical once-only flows
   * like charging money, finalizing an order, etc. Those should use RPC
   * (so the caller gets an explicit response and can retry),
   * or a dedicated idempotent pipeline using raw JetStream/NATS.
   *
   * Core idea:
   * - We ack() as soon as we are sure the handler actually accepted the work.
   * We define "accepted the work" as: the handler emits its first value.
   * Even `undefined` is fine - it's just a signal of liveness/acceptance.
   *
   * - After we ack(), we consider the event consumed. JetStream will NOT
   * redeliver it to another consumer. At that point the handler "owns"
   * the long-running work.
   *
   * - If the handler fails BEFORE first emission, we nak() instead of ack().
   * That tells JetStream "try another pod, this one couldn't even start".
   *
   * - If the handler fails AFTER ack, we do nothing transport-level:
   * no nak(), no retry request. Cleanup/compensation is entirely
   * the handler's responsibility.
   *
   * Handler contract:
   * - The handler should emit at least once (even a void/undefined emission)
   * to indicate "I have started". We take(1) from that emission.
   * - If the handler never emits and also doesn't throw, we will never ack().
   * JetStream will eventually see ack_wait expire and may redeliver.
   *
   * Steps:
   * 1. Resolve handler. If no handler - term(), because retry won't help.
   * 2. Decode payload and build RpcContext (the same context object we reuse).
   * 3. Convert handler result into an Observable and take(1).
   * 4. On first next():
   * - ack() the message
   * - mark it as accepted, so no other pod will see it
   * 5. On error before ack:
   * - nak() so the broker may redeliver elsewhere
   * 6. On error after ack:
   * - swallow at transport level; it's now business logic's problem.
   *
   * @param msg
   */

  protected handleEvent(msg: JsMsg): Observable<void> {
    const handler = this.patternRegistry.getHandler(msg.subject);

    if (!handler) {
      msg.term(`No handler found for Event subject: ${msg.subject}`);
      this.logger.error(`No handler found for subject: ${msg.subject}`);

      return of(void 0);
    }

    const ctx = new RpcContext([msg]);

    let data: unknown;

    try {
      data = this.codec.decode(msg.data);
    } catch (error) {
      this.logger.error(`Failed to decode Event message for ${msg.subject}:`, error);
      msg.term('Invalid message payload');
    }

    let acknowledged = false;

    const work$ = from(handler(data, ctx)).pipe(
      switchMap((inner) =>
        from(inner).pipe(
          tap({
            subscribe: () => {
              if (!acknowledged) {
                msg.ack();
                acknowledged = true;
              }
            },
          }),
        ),
      ),
      take(1),
    );

    return work$.pipe(
      catchError(() => {
        if (!acknowledged) msg.nak();

        return EMPTY;
      }),
      map(() => void 0),
    );
  }
}
