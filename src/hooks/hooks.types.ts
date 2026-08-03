import type { TransportHooks } from '../interfaces';

/** Type-erased callable used to store hooks and subscribers homogeneously. */
export type TransportListener = (...args: unknown[]) => unknown;

/** Internal subscriber registry, shared between a bus and its connection views. */
export type TransportSubscriberRegistry = Map<keyof TransportHooks, TransportListener[]>;
