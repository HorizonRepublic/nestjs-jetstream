import { RESERVED_HEADERS } from '../jetstream.constants';

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
    public readonly data: TData,
    public readonly headers: ReadonlyMap<string, string>,
    public readonly timeout?: number,
  ) {}
}

/**
 * Fluent builder for constructing JetstreamRecord instances.
 *
 * Protected headers (`correlation-id`, `reply-to`, `message-id`) cannot be
 * set by the user — attempting to do so throws an error at build time.
 */
export class JetstreamRecordBuilder<TData = unknown> {
  private data: TData | undefined;
  private readonly headers = new Map<string, string>();
  private timeout: number | undefined;

  public constructor(data?: TData) {
    this.data = data;
  }

  /** Set the message payload. */
  public setData(data: TData): this {
    this.data = data;
    return this;
  }

  /**
   * Set a single custom header.
   *
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
   * @throws Error if any header name is reserved by the transport.
   */
  public setHeaders(headers: Record<string, string>): this {
    for (const [key, value] of Object.entries(headers)) {
      this.setHeader(key, value);
    }

    return this;
  }

  /** Set RPC request timeout in milliseconds. */
  public setTimeout(ms: number): this {
    this.timeout = ms;
    return this;
  }

  /** Build the immutable JetstreamRecord. */
  public build(): JetstreamRecord<TData> {
    return new JetstreamRecord(this.data as TData, new Map(this.headers), this.timeout);
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
