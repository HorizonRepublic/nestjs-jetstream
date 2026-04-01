import { RESERVED_HEADERS } from '../jetstream.constants';

/** Options for one-shot delayed delivery via NATS 2.12 message scheduling. */
export interface ScheduleRecordOptions {
  /** When to deliver the message. Must be in the future. */
  at: Date;
}

/**
 * Immutable message record for JetStream transport.
 *
 * Compatible with NestJS record builder pattern (like RmqRecord, NatsRecord).
 * Pass as the second argument to `client.send()` or `client.emit()`.
 *
 * @example
 * ```typescript
 * const record = new JetstreamRecordBuilder({ id: 1 })
 *   .setHeader('x-tenant', 'acme')
 *   .setTimeout(5000)
 *   .build();
 *
 * client.send('get.user', record);
 * ```
 */
export class JetstreamRecord<TData = unknown> {
  public constructor(
    /** Message payload. */
    public readonly data: TData,
    /** Custom headers set via {@link JetstreamRecordBuilder.setHeader}. */
    public readonly headers: ReadonlyMap<string, string>,
    /** Per-request RPC timeout override in ms. */
    public readonly timeout?: number,
    /** Custom message ID for JetStream deduplication. */
    public readonly messageId?: string,
    /** Schedule options for delayed delivery. */
    public readonly schedule?: ScheduleRecordOptions,
  ) {}
}

/**
 * Fluent builder for constructing JetstreamRecord instances.
 *
 * Protected headers (`correlation-id`, `reply-to`, `error`) cannot be
 * set by the user — attempting to do so throws an error at build time.
 */
export class JetstreamRecordBuilder<TData = unknown> {
  private data: TData | undefined;
  private readonly headers = new Map<string, string>();
  private timeout: number | undefined;
  private messageId: string | undefined;
  private scheduleOptions: ScheduleRecordOptions | undefined;

  public constructor(data?: TData) {
    this.data = data;
  }

  /**
   * Set the message payload.
   *
   * @param data - Payload to serialize via the configured {@link Codec}.
   */
  public setData(data: TData): this {
    this.data = data;
    return this;
  }

  /**
   * Set a single custom header.
   *
   * @param key - Header name (e.g. `'x-tenant'`).
   * @param value - Header value.
   * @throws Error if the header name is reserved by the transport.
   */
  public setHeader(key: string, value: string): this {
    this.validateHeaderKey(key);
    this.headers.set(key, value);
    return this;
  }

  /**
   * Set multiple custom headers at once.
   *
   * @param headers - Key-value pairs to set as headers.
   * @throws Error if any header name is reserved by the transport.
   */
  public setHeaders(headers: Record<string, string>): this {
    for (const [key, value] of Object.entries(headers)) {
      this.setHeader(key, value);
    }

    return this;
  }

  /**
   * Set a custom message ID for JetStream deduplication.
   *
   * NATS JetStream uses this ID to detect duplicate publishes within the
   * stream's `duplicate_window`. If two messages with the same ID arrive
   * within the window, the second is silently dropped.
   *
   * When not set, a random UUID is generated automatically.
   *
   * @param id - Unique message identifier (e.g. order ID, idempotency key).
   *
   * @example
   * ```typescript
   * new JetstreamRecordBuilder(data)
   *   .setMessageId(`order-${order.id}`)
   *   .build();
   * ```
   */
  public setMessageId(id: string): this {
    this.messageId = id;
    return this;
  }

  /**
   * Set per-request RPC timeout.
   *
   * @param ms - Timeout in milliseconds. Overrides the global RPC timeout for this request only.
   */
  public setTimeout(ms: number): this {
    this.timeout = ms;
    return this;
  }

  /**
   * Schedule one-shot delayed delivery.
   *
   * The message is held by NATS and delivered to the event consumer
   * at the specified time. Requires NATS >= 2.12 and `allow_msg_schedules: true`
   * on the event stream (via `events: { stream: { allow_msg_schedules: true } }`).
   *
   * Only meaningful for events (`client.emit()`). If used with RPC
   * (`client.send()`), a warning is logged and the schedule is ignored.
   *
   * @param date - Delivery time. Must be in the future.
   * @throws Error if the date is not in the future.
   */
  public scheduleAt(date: Date): this {
    if (Number.isNaN(date.getTime())) {
      throw new Error('Schedule date is invalid');
    }

    if (date.getTime() <= Date.now()) {
      throw new Error('Schedule date must be in the future');
    }

    this.scheduleOptions = { at: date };

    return this;
  }

  /**
   * Build the immutable {@link JetstreamRecord}.
   *
   * @returns A frozen record ready to pass to `client.send()` or `client.emit()`.
   */
  public build(): JetstreamRecord<TData> {
    return new JetstreamRecord(
      this.data as TData,
      new Map(this.headers),
      this.timeout,
      this.messageId,
      this.scheduleOptions,
    );
  }

  /** Validate that a header key is not reserved. */
  private validateHeaderKey(key: string): void {
    if (RESERVED_HEADERS.has(key)) {
      throw new Error(
        `Header "${key}" is reserved by the JetStream transport and cannot be set manually. ` +
          `Reserved headers: ${[...RESERVED_HEADERS].join(', ')}`,
      );
    }
  }
}
