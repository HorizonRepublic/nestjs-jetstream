import {
  GenericContainer,
  Network,
  StartedNetwork,
  StartedTestContainer,
  Wait,
} from 'testcontainers';
import { connect } from '@nats-io/transport-node';
import { jetstreamManager } from '@nats-io/jetstream';

export const NATS_IMAGE = 'nats:2.14.1';

export interface NatsContainerResult {
  container: StartedTestContainer;
  port: number;
}

export interface NatsClusterResult {
  containers: StartedTestContainer[];
  network: StartedNetwork;
  port: number;
  stop(): Promise<void>;
}

export interface NatsClusterOptions {
  nodes?: number;
  maxFileStoreBytes?: number;
}

const waitForNatsReady = async (port: number, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const nc = await connect({ servers: [`nats://localhost:${port}`], timeout: 1_000 });

      await nc.drain();

      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  throw new Error(`NATS on port ${port} not reachable within ${timeoutMs / 1_000}s`);
};

const waitForJetStreamReady = async (port: number, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const nc = await connect({ servers: [`nats://localhost:${port}`], timeout: 1_000 });

      await jetstreamManager(nc);
      await nc.drain();

      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  throw new Error(`NATS JetStream on port ${port} not ready within ${timeoutMs / 1_000}s`);
};

/**
 * Start a NATS container with JetStream enabled.
 * Returns the started container and the mapped host port.
 * Includes a TCP-level readiness probe to handle port-forwarding lag on Docker Desktop.
 */
export const startNatsContainer = async (): Promise<NatsContainerResult> => {
  const container = await new GenericContainer(NATS_IMAGE)
    .withCommand(['--js', '--store_dir', '/data'])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();

  const port = container.getMappedPort(4222);

  // Docker Desktop on macOS can lag on port forwarding after container start.
  // Poll until we can establish a real NATS connection.
  await waitForNatsReady(port);

  return { container, port };
};

/**
 * Start a NATS container with a fixed host port binding.
 * Required for restart tests — Docker Desktop may reassign dynamic ports on restart,
 * but fixed bindings survive `container.restart()`.
 */
export const startNatsContainerWithFixedPort = async (
  hostPort: number,
): Promise<NatsContainerResult> => {
  const container = await new GenericContainer(NATS_IMAGE)
    .withCommand(['--js', '--store_dir', '/data'])
    .withExposedPorts({ container: 4222, host: hostPort })
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();

  await waitForNatsReady(hostPort);

  return { container, port: hostPort };
};

/**
 * Start a NATS container whose JetStream file store is capped to `maxFileStoreBytes`.
 * Used to provoke insufficient-storage provisioning failures deterministically.
 */
export const startNatsContainerWithFileStoreLimit = async (
  maxFileStoreBytes: number,
): Promise<NatsContainerResult> => {
  const conf = [
    'jetstream {',
    '  store_dir: /data',
    `  max_file_store: ${maxFileStoreBytes}`,
    '}',
    '',
  ].join('\n');

  const container = await new GenericContainer(NATS_IMAGE)
    .withCopyContentToContainer([{ content: conf, target: '/etc/nats/nats.conf' }])
    .withCommand(['-c', '/etc/nats/nats.conf'])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();

  const port = container.getMappedPort(4222);

  await waitForNatsReady(port);

  return { container, port };
};

/**
 * Poll until the cluster can actually host a replicated stream with `expectedPeers`
 * replicas — the real "cluster formed" signal. Creates a tiny probe stream and
 * deletes it. Cluster gossip/RAFT election is slow, so timeouts are generous.
 */
const waitForClusterFormed = async (
  port: number,
  expectedPeers: number,
  timeoutMs = 90_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const probe = '_cluster_probe';

  while (Date.now() < deadline) {
    try {
      const nc = await connect({ servers: [`nats://localhost:${port}`], timeout: 1_000 });
      const jsm = await jetstreamManager(nc);

      // small enough to fit even a 1 MiB max_file_store; replicates across peers
      await jsm.streams.add({
        name: probe,
        subjects: [`${probe}.>`],
        num_replicas: expectedPeers,
        max_bytes: 64 * 1024,
      });
      await jsm.streams.delete(probe);
      await nc.drain();

      return;
    } catch {
      // peers not all healthy yet
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `NATS cluster on port ${port} did not form ${expectedPeers} peers within ${timeoutMs / 1_000}s`,
  );
};

/**
 * Start a multi-node NATS JetStream cluster on a shared Docker network.
 * Each node runs in clustered mode with routes to every peer (`n0`,`n1`,...).
 * Used to provoke placement failures (e.g. `num_replicas` unsatisfiable by peers).
 *
 * @returns Started containers, the shared network, node-0's mapped client port, and a `stop()`.
 */
export const startNatsCluster = async (
  opts: NatsClusterOptions = {},
): Promise<NatsClusterResult> => {
  const nodeCount = opts.nodes ?? 3;

  if (nodeCount < 1) {
    throw new Error('Cluster requires at least one node');
  }

  const aliases = Array.from({ length: nodeCount }, (_, i) => `n${i}`);
  const maxFileStore = opts.maxFileStoreBytes ?? 5 * 1024 * 1024 * 1024;
  const routes = aliases.map((a) => `nats-route://${a}:6222`).join(', ');
  const network = await new Network().start();

  const buildConf = (alias: string): string =>
    [
      `server_name: ${alias}`,
      'jetstream {',
      '  store_dir: /data',
      `  max_file_store: ${maxFileStore}`,
      '}',
      'cluster {',
      '  name: c1',
      '  listen: 0.0.0.0:6222',
      `  routes: [ ${routes} ]`,
      '}',
      '',
    ].join('\n');

  const containers: StartedTestContainer[] = [];

  const stop = async (): Promise<void> => {
    for (const c of containers) {
      await c.stop().catch(() => undefined);
    }

    await network.stop().catch(() => undefined);
  };

  try {
    for (const alias of aliases) {
      const container = await new GenericContainer(NATS_IMAGE)
        .withNetwork(network)
        .withNetworkAliases(alias)
        .withCopyContentToContainer([{ content: buildConf(alias), target: '/etc/nats/nats.conf' }])
        .withCommand(['-c', '/etc/nats/nats.conf'])
        .withExposedPorts(4222, 6222)
        .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
        .start();

      containers.push(container);
    }

    const [node0] = containers;
    const port = node0!.getMappedPort(4222);

    await waitForNatsReady(port);
    await waitForClusterFormed(port, nodeCount);

    return { containers, network, port, stop };
  } catch (err) {
    await stop();
    throw err;
  }
};

/**
 * Restart a NATS container and wait for JetStream readiness.
 * Container filesystem (including JetStream store) persists across restarts.
 *
 * @returns The mapped host port after restart. Dynamic ports may change on restart;
 *   callers using fixed port bindings (via `startNatsContainerWithFixedPort`) can
 *   safely ignore the return value since the port is stable.
 */
export const restartNatsContainer = async (container: StartedTestContainer): Promise<number> => {
  await container.restart();

  const newPort = container.getMappedPort(4222);

  await waitForJetStreamReady(newPort);

  return newPort;
};
