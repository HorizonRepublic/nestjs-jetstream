import { Logger } from '@nestjs/common';
import { MessageHandler } from '@nestjs/microservices';

import { MessageKind, StreamKind } from '../../interfaces';
import type { JetstreamModuleOptions, PatternsByKind, RegisteredHandler, SubjectKind } from '../../interfaces';
import { buildBroadcastSubject, buildSubject, internalName } from '../../jetstream.constants';

/** Maps StreamKind to a human-readable label for logging. */
const HANDLER_LABELS: Record<StreamKind, string> = {
  [StreamKind.Broadcast]: StreamKind.Broadcast,
  [StreamKind.Ordered]: StreamKind.Ordered,
  [StreamKind.Event]: MessageKind.Event,
  [StreamKind.Command]: MessageKind.Rpc,
};

/**
 * Registry mapping NATS subjects to NestJS message handlers.
 *
 * Handles subject normalization and categorization:
 * - Detects broadcast handlers via `extras.broadcast` metadata
 * - Normalizes full NATS subjects back to user-facing patterns
 * - Provides lists of patterns by category for stream/consumer setup
 */
export class PatternRegistry {
  private readonly logger = new Logger('Jetstream:PatternRegistry');
  private readonly registry = new Map<string, RegisteredHandler>();

  // Cached after registerHandlers() — the registry is immutable from that point
  private cachedPatterns: PatternsByKind | null = null;

  public constructor(private readonly options: JetstreamModuleOptions) {}

  /**
   * Register all handlers from the NestJS strategy.
   *
   * @param handlers Map of pattern -> MessageHandler from `Server.getHandlers()`.
   */
  public registerHandlers(handlers: Map<string, MessageHandler>): void {
    const serviceName = this.options.name;

    for (const [pattern, handler] of handlers) {
      const extras = handler.extras as Record<string, unknown> | undefined;
      const isEvent = handler.isEventHandler ?? false;
      const isBroadcast = !!extras?.broadcast;
      const isOrdered = !!extras?.ordered;

      if (isBroadcast && isOrdered) {
        throw new Error(
          `Handler "${pattern}" cannot be both broadcast and ordered. Use one or the other.`,
        );
      }

      const kind: StreamKind = isBroadcast
        ? StreamKind.Broadcast
        : isOrdered
          ? StreamKind.Ordered
          : isEvent
            ? StreamKind.Event
            : StreamKind.Command;

      const fullSubject =
        kind === StreamKind.Broadcast
          ? buildBroadcastSubject(pattern)
          : buildSubject(serviceName, kind as SubjectKind, pattern);

      this.registry.set(fullSubject, {
        handler,
        pattern,
        isEvent: isEvent && !isOrdered,
        isBroadcast,
        isOrdered,
      });

      this.logger.debug(`Registered ${HANDLER_LABELS[kind]}: ${pattern} -> ${fullSubject}`);
    }

    this.cachedPatterns = this.buildPatternsByKind();
    this.logSummary();
  }

  /** Find handler for a full NATS subject. */
  public getHandler(subject: string): MessageHandler | null {
    return this.registry.get(subject)?.handler ?? null;
  }

  /** Get all registered broadcast patterns (for consumer filter_subject setup). */
  public getBroadcastPatterns(): string[] {
    return this.getPatternsByKind().broadcasts.map((p) => buildBroadcastSubject(p));
  }

  public hasBroadcastHandlers(): boolean {
    return this.getPatternsByKind().broadcasts.length > 0;
  }

  public hasRpcHandlers(): boolean {
    return this.getPatternsByKind().commands.length > 0;
  }

  public hasEventHandlers(): boolean {
    return this.getPatternsByKind().events.length > 0;
  }

  public hasOrderedHandlers(): boolean {
    return this.getPatternsByKind().ordered.length > 0;
  }

  /** Get fully-qualified NATS subjects for ordered handlers. */
  public getOrderedSubjects(): string[] {
    return this.getPatternsByKind().ordered.map((p) =>
      buildSubject(this.options.name, StreamKind.Ordered, p),
    );
  }

  /** Get patterns grouped by kind (cached after registration). */
  public getPatternsByKind(): PatternsByKind {
    return this.cachedPatterns ?? this.buildPatternsByKind();
  }

  /** Normalize a full NATS subject back to the user-facing pattern. */
  public normalizeSubject(subject: string): string {
    const name = internalName(this.options.name);
    const prefixes = [
      `${name}.${StreamKind.Command}.`,
      `${name}.${StreamKind.Event}.`,
      `${name}.${StreamKind.Ordered}.`,
      `${StreamKind.Broadcast}.`,
    ];

    for (const prefix of prefixes) {
      if (subject.startsWith(prefix)) {
        return subject.slice(prefix.length);
      }
    }

    return subject;
  }

  private buildPatternsByKind(): PatternsByKind {
    const events: string[] = [];
    const commands: string[] = [];
    const broadcasts: string[] = [];
    const ordered: string[] = [];

    for (const entry of this.registry.values()) {
      if (entry.isBroadcast) broadcasts.push(entry.pattern);
      else if (entry.isOrdered) ordered.push(entry.pattern);
      else if (entry.isEvent) events.push(entry.pattern);
      else commands.push(entry.pattern);
    }

    return { events, commands, broadcasts, ordered };
  }

  private logSummary(): void {
    const { events, commands, broadcasts, ordered } = this.getPatternsByKind();

    const parts = [
      `${commands.length} RPC`,
      `${events.length} events`,
      `${broadcasts.length} broadcasts`,
    ];

    if (ordered.length > 0) {
      parts.push(`${ordered.length} ordered`);
    }

    this.logger.log(`Registered handlers: ${parts.join(', ')}`);
  }
}
