import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { connect } from 'nats';

export const NATS_IMAGE = 'nats:2.12.6';

export interface NatsContainerResult {
  container: StartedTestContainer;
  port: number;
}

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
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      const nc = await connect({ servers: [`nats://localhost:${port}`], timeout: 1_000 });

      await nc.drain();

      return { container, port };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  throw new Error(`NATS container on port ${port} not reachable within 15s`);
};

/**
 * Restart a NATS container and wait for JetStream readiness.
 * Container filesystem (including JetStream store) persists across restarts.
 */
export const restartNatsContainer = async (
  container: StartedTestContainer,
  port: number,
): Promise<void> => {
  await container.restart();

  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      const nc = await connect({
        servers: [`nats://localhost:${port}`],
        timeout: 1_000,
      });

      await nc.jetstreamManager();
      await nc.drain();

      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  throw new Error('NATS not ready after container restart');
};
