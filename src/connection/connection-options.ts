import type {
  JetstreamConnectionOptions,
  JetstreamModuleOptions,
  NormalizedConnectionsConfig,
  ResolvedConnectionOptions,
} from '../interfaces';

const DEFAULT_CONNECTION_NAME = 'default';
const DEFAULT_NATS_PORT = '4222';

const canonicalizeServer = (url: string): string => {
  const withoutScheme = url.replace(/^[a-z]+:\/\//i, '');
  const hasPort = /:\d+$/.test(withoutScheme);

  return (hasPort ? withoutScheme : `${withoutScheme}:${DEFAULT_NATS_PORT}`).toLowerCase();
};

/** Order-insensitive identity of a server set, used to catch duplicated clusters. */
const serverSetKey = (servers: string[]): string =>
  [...new Set(servers.map(canonicalizeServer))].toSorted().join(',');

/**
 * Merge one connection over the root options.
 *
 * `name`, `hooks`, `metrics`, `otel` and `onDeadLetter` describe the service as
 * a whole; a connection never overrides them because they observe and aggregate
 * across every connection.
 */
const mergeConnection = (
  root: JetstreamModuleOptions,
  name: string,
  connection: JetstreamConnectionOptions,
): ResolvedConnectionOptions => {
  const {
    servers: _servers,
    connections: _connections,
    defaultConnection: _defaultConnection,
    ...rest
  } = root;

  const declared = Object.fromEntries(
    Object.entries(connection).filter(([, value]) => value !== undefined),
  );

  return {
    ...rest,
    ...declared,
    servers: connection.servers,
    connectionName: name,
    critical: connection.critical ?? true,
  } as ResolvedConnectionOptions;
};

const resolveDefaultName = (names: string[], requested: string | undefined): string => {
  if (requested !== undefined) {
    if (!names.includes(requested)) {
      throw new Error(
        `defaultConnection "${requested}" is not among the configured connections: ${names.join(', ')}.`,
      );
    }

    return requested;
  }

  if (names.includes(DEFAULT_CONNECTION_NAME)) return DEFAULT_CONNECTION_NAME;

  const [only] = names;

  if (only !== undefined && names.length === 1) return only;

  throw new Error(
    `defaultConnection is required when no connection is named "${DEFAULT_CONNECTION_NAME}". ` +
      `Configured connections: ${names.join(', ')}.`,
  );
};

const assertDistinctClusters = (connections: ResolvedConnectionOptions[]): void => {
  const seen = new Map<string, string>();

  for (const connection of connections) {
    const key = serverSetKey(connection.servers);
    const previous = seen.get(key);

    if (previous !== undefined) {
      throw new Error(
        `Connections "${previous}" and "${connection.connectionName}" point at the same NATS ` +
          `cluster (${connection.servers.join(', ')}). Two connections into one cluster would ` +
          `resolve identical stream names and overwrite each other's configuration.`,
      );
    }

    seen.set(key, connection.connectionName);
  }
};

/**
 * Rewrite module options into the multi-connection form and validate them.
 *
 * The flat `{ servers }` form becomes a single connection named `default`, so
 * no code path downstream deals with two shapes.
 *
 * @param options Raw root module options.
 * @returns Every resolved connection plus the default connection's name.
 */
export const normalizeOptions = (options: JetstreamModuleOptions): NormalizedConnectionsConfig => {
  const hasServers = options.servers !== undefined;
  const hasConnections = options.connections !== undefined;

  if (hasServers === hasConnections) {
    throw new Error(
      'JetstreamModule requires exactly one of `servers` or `connections`, not both and not neither.',
    );
  }

  const map: Record<string, JetstreamConnectionOptions> = options.connections ?? {
    [DEFAULT_CONNECTION_NAME]: { servers: options.servers ?? [] },
  };

  const entries = Object.entries(map);

  if (entries.length === 0) {
    throw new Error('`connections` must declare at least one connection.');
  }

  for (const [name, connection] of entries) {
    if (name.trim().length === 0) {
      throw new Error('Connection names must be non-empty.');
    }

    if (connection.servers.length === 0) {
      throw new Error(`Connection "${name}" must declare at least one server.`);
    }
  }

  const connections = entries.map(([name, connection]) =>
    mergeConnection(options, name, connection),
  );

  assertDistinctClusters(connections);

  return {
    connections,
    defaultConnection: resolveDefaultName(
      entries.map(([name]) => name),
      options.defaultConnection,
    ),
  };
};
