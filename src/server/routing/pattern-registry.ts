import { Logger } from '@nestjs/common';
import { MessageHandler } from '@nestjs/microservices';

import { MessageKind, StreamKind } from '../../interfaces';
import type {
  DeclaredSchedule,
  JetstreamModuleOptions,
  PatternsByKind,
  RegisteredHandler,
  RecurringScheduleSpec,
  ScheduleSpec,
} from '../../interfaces';
import { metadataKey } from '../../jetstream.constants';
import {
  assertLiteralSubject,
  isAtSchedule,
  JetstreamScheduleError,
  ScheduleErrorReason,
  validateScheduleSpec,
} from '../../schedule';
import { NameResolver } from '../infrastructure/name-resolver';

/** Maps StreamKind to a human-readable label for logging. */
const HANDLER_LABELS: Record<StreamKind, string> = {
  [StreamKind.Broadcast]: StreamKind.Broadcast,
  [StreamKind.Ordered]: StreamKind.Ordered,
  [StreamKind.Event]: MessageKind.Event,
  [StreamKind.Command]: MessageKind.Rpc,
  [StreamKind.Schedule]: 'schedule',
};

/** The stream a handler consumes from, given its delivery flags. */
const resolveHandlerKind = (
  isScheduled: boolean,
  isBroadcast: boolean,
  isOrdered: boolean,
  isEvent: boolean,
): StreamKind => {
  if (isScheduled) return StreamKind.Schedule;
  if (isBroadcast) return StreamKind.Broadcast;
  if (isOrdered) return StreamKind.Ordered;
  if (isEvent) return StreamKind.Event;

  return StreamKind.Command;
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

  // Cached after registerHandlers(); the registry is immutable from that point
  private cachedPatterns: PatternsByKind | null = null;
  private _hasEvents = false;
  private _hasCommands = false;
  private _hasBroadcasts = false;
  private _hasOrdered = false;
  private _hasSchedules = false;
  private _hasMetadata = false;

  public constructor(
    private readonly options: JetstreamModuleOptions,
    private readonly names: NameResolver,
  ) {}

  /**
   * Register all handlers from the NestJS strategy.
   *
   * @param handlers Map of pattern -> MessageHandler from `Server.getHandlers()`.
   */
  public registerHandlers(handlers: Map<string, MessageHandler>): void {
    for (const [pattern, handler] of handlers) {
      const extras = handler.extras as Record<string, unknown> | undefined;
      const isEvent = handler.isEventHandler ?? false;
      const isBroadcast = !!extras?.broadcast;
      const isOrdered = !!extras?.ordered;
      const rawSchedule: unknown = extras?.schedule;
      // `schedule: false` from JavaScript reads as no schedule rather than a malformed one.
      const isScheduled = rawSchedule !== undefined && rawSchedule !== false;
      const meta = extras?.meta as Record<string, unknown> | undefined;

      if (isBroadcast && isOrdered) {
        throw new Error(
          `Handler "${pattern}" cannot be both broadcast and ordered. Use one or the other.`,
        );
      }

      const declared = isScheduled
        ? this.declaredSchedule(pattern, rawSchedule, isEvent, isBroadcast || isOrdered)
        : undefined;

      const kind = resolveHandlerKind(isScheduled, isBroadcast, isOrdered, isEvent);

      const fullSubject = this.names.subject(kind, pattern);

      this.registry.set(fullSubject, {
        handler,
        pattern,
        isEvent: isEvent && !isOrdered,
        isBroadcast,
        isOrdered,
        isScheduled,
        ...(declared ? { schedule: declared } : {}),
        meta,
      });

      this.logger.debug(`Registered ${HANDLER_LABELS[kind]}: ${pattern} -> ${fullSubject}`);
    }

    this.cachedPatterns = this.buildPatternsByKind();
    this._hasEvents = this.cachedPatterns.events.length > 0;
    this._hasCommands = this.cachedPatterns.commands.length > 0;
    this._hasBroadcasts = this.cachedPatterns.broadcasts.length > 0;
    this._hasOrdered = this.cachedPatterns.ordered.length > 0;
    this._hasSchedules = this.cachedPatterns.schedules.length > 0;
    this._hasMetadata = [...this.registry.values()].some((entry) => entry.meta !== undefined);
    this.logSummary();
  }

  /** Find handler for a full NATS subject. */
  public getHandler(subject: string): MessageHandler | null {
    return this.registry.get(subject)?.handler ?? null;
  }

  /**
   * Resolve the declared pattern and {@link StreamKind} for a full NATS subject.
   *
   * Returns `null` when the subject is not registered. The declared pattern is
   * the value the user passed to `@EventPattern`/`@MessagePattern`: stable and
   * bounded, suitable for use as a Prometheus label without cardinality risk.
   */
  public resolveDeclared(subject: string): { pattern: string; kind: StreamKind } | null {
    const entry = this.registry.get(subject);

    if (!entry) return null;

    return { pattern: entry.pattern, kind: this.resolveStreamKind(entry) };
  }

  /** Get all registered broadcast patterns (for consumer filter_subject setup). */
  public getBroadcastPatterns(): string[] {
    return this.getPatternsByKind().broadcasts.map((p) =>
      this.names.subject(StreamKind.Broadcast, p),
    );
  }

  /** Get registered event patterns as raw user-declared patterns. */
  public getEventPatterns(): string[] {
    return this.getPatternsByKind().events;
  }

  /** Get registered command patterns as raw user-declared patterns. */
  public getCommandPatterns(): string[] {
    return this.getPatternsByKind().commands;
  }

  public hasBroadcastHandlers(): boolean {
    return this._hasBroadcasts;
  }

  public hasRpcHandlers(): boolean {
    return this._hasCommands;
  }

  public hasEventHandlers(): boolean {
    return this._hasEvents;
  }

  public hasOrderedHandlers(): boolean {
    return this._hasOrdered;
  }

  public hasScheduleHandlers(): boolean {
    return this._hasSchedules;
  }

  /** Fully-qualified tick subjects of the handlers that receive schedules. */
  public getScheduleSubjects(): string[] {
    return this.getPatternsByKind().schedules.map((p) =>
      this.names.subject(StreamKind.Schedule, p),
    );
  }

  /** The schedules handlers declare, reconciled at boot. Dynamic-only handlers declare none. */
  public getDeclaredSchedules(): DeclaredSchedule[] {
    return [...this.registry.values()].flatMap((entry) =>
      entry.schedule ? [{ pattern: entry.pattern, spec: entry.schedule }] : [],
    );
  }

  /** Get fully-qualified NATS subjects for ordered handlers. */
  public getOrderedSubjects(): string[] {
    return this.getPatternsByKind().ordered.map((p) => this.names.subject(StreamKind.Ordered, p));
  }

  /** Check if any registered handler has metadata. */
  public hasMetadata(): boolean {
    return this._hasMetadata;
  }

  /**
   * Get handler metadata entries for KV publishing.
   *
   * Returns a map of KV key -> metadata object for all handlers that have `meta`.
   * Key format: `{serviceName}.{kind}.{pattern}`.
   */
  public getMetadataEntries(): Map<string, Record<string, unknown>> {
    const entries = new Map<string, Record<string, unknown>>();

    for (const entry of this.registry.values()) {
      if (!entry.meta) continue;

      const kind = this.resolveStreamKind(entry);
      const key = metadataKey(this.options.name, kind, entry.pattern);

      entries.set(key, entry.meta);
    }

    return entries;
  }

  /** Get patterns grouped by kind (cached after registration). */
  public getPatternsByKind(): PatternsByKind {
    const patterns = this.cachedPatterns ?? this.buildPatternsByKind();

    return {
      events: [...patterns.events],
      commands: [...patterns.commands],
      broadcasts: [...patterns.broadcasts],
      ordered: [...patterns.ordered],
      schedules: [...patterns.schedules],
    };
  }

  private buildPatternsByKind(): PatternsByKind {
    const events: string[] = [];
    const commands: string[] = [];
    const broadcasts: string[] = [];
    const ordered: string[] = [];
    const schedules: string[] = [];

    for (const entry of this.registry.values()) {
      if (entry.isScheduled) schedules.push(entry.pattern);
      else if (entry.isBroadcast) broadcasts.push(entry.pattern);
      else if (entry.isOrdered) ordered.push(entry.pattern);
      else if (entry.isEvent) events.push(entry.pattern);
      else commands.push(entry.pattern);
    }

    return { events, commands, broadcasts, ordered, schedules };
  }

  private resolveStreamKind(entry: RegisteredHandler): StreamKind {
    if (entry.isScheduled) return StreamKind.Schedule;
    if (entry.isBroadcast) return StreamKind.Broadcast;
    if (entry.isOrdered) return StreamKind.Ordered;
    if (entry.isEvent) return StreamKind.Event;

    return StreamKind.Command;
  }

  /** Validate a handler's schedule extra and return the schedule it declares, if any. */
  private declaredSchedule(
    pattern: string,
    schedule: unknown,
    isEvent: boolean,
    hasOtherDelivery: boolean,
  ): RecurringScheduleSpec | undefined {
    if (!isEvent) {
      throw new Error(
        `Handler "${pattern}" has a schedule; schedules belong on @EventPattern only.`,
      );
    }

    if (hasOtherDelivery) {
      throw new Error(
        `Handler "${pattern}" cannot be both scheduled and broadcast or ordered. Use one or the other.`,
      );
    }

    assertLiteralSubject(pattern, ScheduleErrorReason.InvalidPattern);
    if (schedule === true) return undefined;

    if (typeof schedule !== 'object' || schedule === null) {
      throw new JetstreamScheduleError(
        ScheduleErrorReason.InvalidSpec,
        `Handler "${pattern}" has schedule ${JSON.stringify(schedule)}; expected a schedule spec or true.`,
      );
    }

    const spec = schedule as ScheduleSpec;

    // Declared schedules are re-created on every boot, so a one-shot would fire again each time.
    if (isAtSchedule(spec)) {
      throw new JetstreamScheduleError(
        ScheduleErrorReason.InvalidAt,
        `Handler "${pattern}" declares a one-shot schedule; create one-shot schedules with JetstreamClient.schedule().`,
      );
    }

    validateScheduleSpec(spec);

    return spec;
  }

  private logSummary(): void {
    const { events, commands, broadcasts, ordered, schedules } = this.getPatternsByKind();

    const parts = [
      `${commands.length} RPC`,
      `${events.length} events`,
      `${broadcasts.length} broadcasts`,
    ];

    if (ordered.length > 0) {
      parts.push(`${ordered.length} ordered`);
    }

    if (schedules.length > 0) {
      parts.push(`${schedules.length} scheduled`);
    }

    this.logger.log(`Registered handlers: ${parts.join(', ')}`);
  }
}
