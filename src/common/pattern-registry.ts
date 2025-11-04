import { Injectable } from '@nestjs/common';
import { MessageHandler } from '@nestjs/microservices';

import { JetStreamKind } from '../enum';
import { JetstreamStrategy } from '../server/jetstream.strategy';

import { IJetstreamTransportOptions } from './types';

/**
 * Registry for managing NATS JetStream message patterns and their handlers.
 * Provides pattern-to-handler mapping and subject normalization for routing.
 */
@Injectable()
export class PatternRegistry {
  private readonly handlers: Map<string, MessageHandler>;

  public constructor(
    private readonly options: IJetstreamTransportOptions,
    private readonly strategy: JetstreamStrategy,
  ) {
    this.handlers = this.strategy.getHandlers();
  }

  /**
   * Retrieves handler for a given subject by normalizing and matching patterns.
   *
   * @param subject Full NATS subject (e.g., "service.Event.user.created").
   * @returns Message handler or null if no match found.
   */
  public getHandler(subject: string): MessageHandler | null {
    const normalizedPattern = this.normalizeSubject(subject);

    return this.handlers.get(normalizedPattern) ?? null;
  }

  /**
   * Lists all registered patterns grouped by type and logs them.
   *
   * @returns Object containing events and messages arrays.
   */
  public list(): { events: string[]; messages: string[] } {
    const { events, messages } = this.categorizeHandlers();

    return { events, messages };
  }

  /**
   * Normalizes subject by removing service prefix and kind identifier.
   * Converts "service.Event.user.created" to "user.created".
   *
   * @param subject Full NATS subject.
   * @returns Normalized pattern without a service prefix.
   */
  private normalizeSubject(subject: string): string {
    const commandPrefix = this.buildPrefix(JetStreamKind.Command);
    const eventPrefix = this.buildPrefix(JetStreamKind.Event);

    return subject.replace(commandPrefix, '').replace(eventPrefix, '');
  }

  /**
   * Builds subject prefix for a given kind.
   *
   * @param kind JetStream kind (Event or Command).
   * @returns Formatted prefix string.
   */
  private buildPrefix(kind: JetStreamKind): string {
    return `${this.options.name}.${kind}.`;
  }

  /**
   * Categorizes registered handlers into events and messages.
   *
   * @returns Object with separated handler arrays.
   */
  private categorizeHandlers(): { events: string[]; messages: string[] } {
    const events: string[] = [];
    const messages: string[] = [];

    for (const [pattern, handler] of this.handlers) {
      const targetArray = handler.isEventHandler ? events : messages;

      targetArray.push(pattern);
    }

    return { events, messages };
  }
}
