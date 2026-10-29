import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

import type { EventBus } from '../../../hooks';
import { StreamKind, TransportEvent } from '../../../interfaces';
import { createHandlerReporter } from '../handler-reporter';
import type { PatternRegistry } from '../pattern-registry';

describe(createHandlerReporter, () => {
  let eventBus: Mocked<EventBus>;
  let patternRegistry: Mocked<PatternRegistry>;
  let subject: string;

  beforeEach(() => {
    eventBus = createMock<EventBus>({ hasHook: vi.fn().mockReturnValue(true) });
    patternRegistry = createMock<PatternRegistry>({
      resolveDeclared: vi.fn().mockReturnValue(null),
    });
    subject = `svc.ev.${faker.lorem.word()}`;
  });

  afterEach(vi.resetAllMocks);

  it('should report the declared pattern and kind', () => {
    // Given
    patternRegistry.resolveDeclared.mockReturnValue({
      pattern: 'order.*',
      kind: StreamKind.Broadcast,
    });
    const sut = createHandlerReporter(eventBus, patternRegistry, StreamKind.Event);

    // When
    sut({ subject }, performance.now(), 'success');

    // Then
    expect(eventBus.emit).toHaveBeenCalledWith(
      TransportEvent.HandlerCompleted,
      'order.*',
      StreamKind.Broadcast,
      expect.any(Number),
      'success',
    );
  });

  it('should fall back to the wire subject and the router kind for an undeclared subject', () => {
    // Given
    const sut = createHandlerReporter(eventBus, patternRegistry, StreamKind.Command);

    // When
    sut({ subject }, performance.now(), 'error');

    // Then
    expect(eventBus.emit).toHaveBeenCalledWith(
      TransportEvent.HandlerCompleted,
      subject,
      StreamKind.Command,
      expect.any(Number),
      'error',
    );
  });

  it('should skip resolving when nothing listens', () => {
    // Given
    eventBus.hasHook.mockReturnValue(false);
    const sut = createHandlerReporter(eventBus, patternRegistry, StreamKind.Event);

    // When
    sut({ subject }, performance.now(), 'success');

    // Then
    expect(patternRegistry.resolveDeclared).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});
