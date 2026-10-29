import type { EventBus } from '../../hooks';
import { TransportEvent } from '../../interfaces';
import type { StreamKind } from '../../interfaces';
import type { PatternRegistry } from './pattern-registry';
import type { HandlerReporter } from './routing.types';

/**
 * Reports handler completion to the event bus using the declared pattern
 * (not the wire subject) so metric cardinality stays bounded. hasHook is
 * checked per-emit, not snapshotted, so late subscribers (e.g. the metrics
 * service bootstrapping after this router starts) still receive events.
 */
export const createHandlerReporter =
  (eventBus: EventBus, patternRegistry: PatternRegistry, kind: StreamKind): HandlerReporter =>
  (msg, startedAt, status) => {
    if (!eventBus.hasHook(TransportEvent.HandlerCompleted)) return;

    const declared = patternRegistry.resolveDeclared(msg.subject);
    const pattern = declared?.pattern ?? msg.subject;
    const declaredKind = declared?.kind ?? kind;
    const durationMs = performance.now() - startedAt;

    eventBus.emit(TransportEvent.HandlerCompleted, pattern, declaredKind, durationMs, status);
  };
