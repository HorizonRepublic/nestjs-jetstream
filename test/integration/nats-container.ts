import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { connect } from '@nats-io/transport-node';
import { jetstreamManager } from '@nats-io/jetstream';

export const NATS_IMAGE = 'nats:2.14.1';

export interface NatsContainerResult {
  container: StartedTestContainer;
  port: number;
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
