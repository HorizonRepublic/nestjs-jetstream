export const getJetStreamTransportToken = (name: string): string => `jetstream-transport-${name}`;

export const getJetStreamClientToken = (name: string): string => `jetstream-client-proxy-${name}`;

export const getJetStreamServerOptionsToken = (name: string): string =>
  `jetstream-server-options-${name}`;

export const getJetStreamClientOptionsToken = <T extends string>(
  name: T,
): `jetstream-client-options-${T}` => `jetstream-client-options-${name}`;

export const getToken = {
  connection: (name: string): string => `jetstream-connection-${name}`,
  strategy: (name: string): string => `jetstream-strategy-${name}`,
  stream: (name: string): string => `jetstream-stream-${name}`,
  consumer: (name: string): string => `jetstream-consumer-${name}`,
  patternRegistry: (name: string): string => `jetstream-pattern-registry-${name}`,
  message: (name: string): string => `jetstream-message-${name}`,
  messageRouting: (name: string): string => `jetstream-message-routing-${name}`,
} as const;
