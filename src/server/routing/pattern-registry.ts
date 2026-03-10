import { Logger } from '@nestjs/common';
import { MessageHandler } from '@nestjs/microservices';

import type { JetstreamModuleOptions, PatternsByKind, RegisteredHandler } from '../../interfaces';
import { buildBroadcastSubject, buildSubject, internalName } from '../../jetstream.constants';

/**
 * Registry mapping NATS subjects to NestJS message handlers.
 *
 * Handles subject normalization and categorization:
 * - Detects broadcast handlers via `extras.broadcast` metadata
 * - Normalizes full NATS subjects back to user-facing patterns
 * - Provides lists of patterns by category for stream/consumer setup
 */
export class PatternRegistry {
  private readonly logger = new Logger(PatternRegistry.name);
  private readonly registry = new Map<string, RegisteredHandler>();

  public constructor(private readonly options: JetstreamModuleOptions) {}

  /**
   * Register all handlers from the NestJS strategy.
   *
   * @param handlers Map of pattern -> MessageHandler from `Server.getHandlers()`.
   */
  public registerHandlers(handlers: Map<string, MessageHandler>): void {
    const serviceName = this.options.name;

    for (const [pattern, handler] of handlers) {
      const isEvent = handler.isEventHandler ?? false;
      const isBroadcast = !!(handler.extras as Record<string, unknown> | undefined)?.broadcast;

      // Build the full NATS subject this handler should receive
      let fullSubject: string;

      if (isBroadcast) {
        fullSubject = buildBroadcastSubject(pattern);
      } else if (isEvent) {
        fullSubject = buildSubject(serviceName, 'ev', pattern);
      } else {
        fullSubject = buildSubject(serviceName, 'cmd', pattern);
      }

      this.registry.set(fullSubject, {
        handler,
        pattern,
        isEvent,
        isBroadcast,
      });

      let kind: string;

      if (isBroadcast) {
        kind = 'broadcast';
      } else if (isEvent) {
        kind = 'event';
      } else {
        kind = 'rpc';
      }

      this.logger.debug(`Registered ${kind}: ${pattern} -> ${fullSubject}`);
    }

    this.logSummary();
  }

  /** Find handler for a full NATS subject. */
  public getHandler(subject: string): MessageHandler | null {
    return this.registry.get(subject)?.handler ?? null;
  }

  /** Get all registered broadcast patterns (for consumer filter_subject setup). */
  public getBroadcastPatterns(): string[] {
    return Array.from(this.registry.values())
      .filter((r) => r.isBroadcast)
      .map((r) => `broadcast.${r.pattern}`);
  }

  /** Check if any broadcast handlers are registered. */
  public hasBroadcastHandlers(): boolean {
    return Array.from(this.registry.values()).some((r) => r.isBroadcast);
  }

  /** Check if any RPC (command) handlers are registered. */
  public hasRpcHandlers(): boolean {
    return Array.from(this.registry.values()).some((r) => !r.isEvent && !r.isBroadcast);
  }

  /** Check if any workqueue event handlers are registered. */
  public hasEventHandlers(): boolean {
    return Array.from(this.registry.values()).some((r) => r.isEvent && !r.isBroadcast);
  }

  /** Get patterns grouped by kind. */
  public getPatternsByKind(): PatternsByKind {
    const events: string[] = [];
    const commands: string[] = [];
    const broadcasts: string[] = [];

    for (const entry of this.registry.values()) {
      if (entry.isBroadcast) broadcasts.push(entry.pattern);
      else if (entry.isEvent) events.push(entry.pattern);
      else commands.push(entry.pattern);
    }

    return { events, commands, broadcasts };
  }

  /** Normalize a full NATS subject back to the user-facing pattern. */
  public normalizeSubject(subject: string): string {
    const name = internalName(this.options.name);
    const prefixes = [`${name}.cmd.`, `${name}.ev.`, 'broadcast.'];

    for (const prefix of prefixes) {
      if (subject.startsWith(prefix)) {
        return subject.slice(prefix.length);
      }
    }

    return subject;
  }

  /** Log a summary of all registered handlers. */
  private logSummary(): void {
    const { events, commands, broadcasts } = this.getPatternsByKind();

    this.logger.log(
      `Registered handlers: ${commands.length} RPC, ${events.length} events, ${broadcasts.length} broadcasts`,
    );
  }
}
