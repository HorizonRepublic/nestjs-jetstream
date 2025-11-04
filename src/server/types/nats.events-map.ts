import { DebugEvents, Events, ServersChanged } from 'nats';

/**
 * Generic type for event callback functions.
 * Accepts any number of arguments of any type and returns void.
 */
type EventCallback = (...args: never[]) => void;

/**
 * Type-safe event map for NATS connection status events.
 * Maps each event type to its callback signature based on Status.data field.
 */
export interface INatsEventsMap extends Record<string, EventCallback> {
  // Connection lifecycle events
  [Events.Disconnect](): void;
  [Events.Reconnect](): void;
  [Events.Update](data: ServersChanged): void;
  [Events.LDM](): void;

  // Error events
  [Events.Error](data: unknown): void;

  // Debug events
  [DebugEvents.Reconnecting](): void;
  [DebugEvents.PingTimer](): void;
  [DebugEvents.StaleConnection](): void;
}
