---
sidebar_position: 1
title: Testing
---

# Testing

The project uses [Vitest](https://vitest.dev/) v4 with a dual-project configuration: **unit tests** run without external dependencies, **integration tests** spin up isolated NATS containers via [Testcontainers](https://testcontainers.com/).

## Philosophy

This library handles real-time message delivery, consumer lifecycle, and self-healing reconnection — things that are notoriously hard to test with mocks alone. Our testing strategy reflects that:

- **Integration tests are first-class citizens.** Every message flow (events, RPC, broadcast, ordered) is tested against a real NATS server. No hand-waved "it works in production" — if it's not tested end-to-end, it's not done.
- **Each test suite gets its own NATS container.** No shared state between suites. No "run tests in order". Suites execute in parallel — because if your tests can't run in parallel, your architecture has a problem.
- **Self-healing is proven, not assumed.** We delete consumers via the JetStream Management API and verify the transport recovers. The self-healing flow is tested with real NATS, not mocked RxJS streams.
- **Unit tests fill the gaps.** Infrastructure error paths (defensive throws, catch blocks, exponential backoff) that can't be triggered through integration get targeted unit tests. Coverage is a tool, not a target — but we track it to make sure we're not lying to ourselves.

## Prerequisites

- **Docker** — Testcontainers starts NATS containers automatically. No manual `docker compose up` needed for tests.
- **Node.js >= 22** and **pnpm**

## Test Commands

| Command | Description |
|---------|-------------|
| `pnpm test` | Run all tests (unit + integration, parallel) |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm test:cov` | Run all tests with coverage reporting |

:::tip
`docker compose up -d` is available for manual testing and debugging, but is **not needed** to run the test suite.
:::

## Test Suites

### Unit Tests

- **Location:** `src/**/*.spec.ts`
- **Setup file:** `test/setup-unit.ts`
- **Timeout:** 10 seconds per test
- **Environment:** Node.js

Unit tests mock all external dependencies and test individual classes/functions in isolation. Infrastructure files (in `src/server/infrastructure/`) prefer integration coverage, but unit tests are used for error paths unreachable through integration.

### Integration Tests

- **Location:** `test/**/*.spec.ts`
- **Timeout:** 30 seconds per test (60s for self-healing scenarios)
- **Parallelism:** Enabled — each suite starts its own NATS container
- **Container image:** `nats:2.12.6` with JetStream and persistent store

Integration tests verify end-to-end behavior: stream/consumer provisioning, message delivery, RPC round-trips, broadcast fan-out, ordered delivery, dead-letter handling, graceful shutdown, and self-healing recovery.

#### How It Works

Every integration suite follows this pattern:

```typescript
import type { StartedTestContainer } from 'testcontainers';
import { startNatsContainer } from './nats-container';

describe('My Feature', () => {
  let container: StartedTestContainer;
  let port: number;
  let nc: NatsConnection;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
    nc = await createNatsConnection(port);
  });

  afterAll(async () => {
    try {
      await nc?.drain();
    } finally {
      await container?.stop();
    }
  });

  it('should do something', async () => {
    const { app } = await createTestApp({ name: 'my-service', port }, [MyController]);
    // ... test against real NATS ...
    await app.close();
  });
});
```

Key helpers in `test/integration/`:

| Helper | Purpose |
|--------|---------|
| `startNatsContainer()` | Start a NATS container with JetStream, return container + random port |
| `createNatsConnection(port)` | Create a standalone NATS connection for assertions |
| `createTestApp({ name, port }, controllers)` | Bootstrap a full NestJS app with the transport |
| `cleanupStreams(nc, serviceName)` | Delete streams/consumers created during a test |
| `waitForCondition(fn, timeoutMs)` | Poll until an async condition is met |
| `uniqueServiceName()` | Generate a unique service name per test |

### Self-Healing Tests

The self-healing suite proves that the transport recovers from consumer failures:

1. Start app, deliver an event, confirm receipt
2. **Delete the consumer** via JetStream Management API
3. Re-create it (simulating eventual recovery)
4. Verify the self-healing flow (catchError → exponential backoff → retry) picks up the re-created consumer
5. Deliver another event, confirm receipt

The test uses a 1-second heartbeat interval (vs 5s production default) for faster failure detection. No `sleep(12s)` hacks — consumer deletion triggers the error path immediately.

## Test Conventions

### System Under Test (`sut`)

The object being tested is always named `sut`:

```typescript
let sut: StreamProvider;

beforeEach(() => {
  sut = new StreamProvider(mockOptions, mockConnection);
});
```

### Mocking with `createMock<T>()`

Use `createMock<T>()` from `@golevelup/ts-vitest` for type-safe mocks:

```typescript
import { createMock } from '@golevelup/ts-vitest';

const mockConnection = createMock<ConnectionProvider>();
```

:::caution
`createMock<JsMsg>()` creates a Proxy where `'ack' in proxy` returns `false` unless you explicitly provide the `ack` property. If your code checks for property existence on `JsMsg`, provide it in the mock setup.
:::

### Fake Data with `@faker-js/faker`

Use `@faker-js/faker` for realistic test data instead of hardcoded strings:

```typescript
import { faker } from '@faker-js/faker';

const serviceName = faker.word.noun();
const pattern = `${faker.word.noun()}.${faker.word.verb()}`;
```

### Given-When-Then Structure

```typescript
it('should create event stream when it does not exist', async () => {
  // Given
  mockJsm.streams.info.mockRejectedValue(streamNotFoundError);

  // When
  await sut.ensureStreams(['ev']);

  // Then
  expect(mockJsm.streams.add).toHaveBeenCalledWith(
    expect.objectContaining({ name: expectedStreamName }),
  );
});
```

### Test Ordering

Tests within a `describe` block follow this order:

1. **Happy path** — the expected successful behavior
2. **Edge cases** — boundary conditions and unusual inputs
3. **Error cases** — failure modes and error handling

### Mock Reset

Always reset mocks after each test:

```typescript
afterEach(() => {
  vi.resetAllMocks();
});
```

### Assertions

Use `await expect(...).rejects` for async errors:

```typescript
await expect(sut.connect()).rejects.toThrow('Connection refused');
```

:::warning
Vitest auto-await for `.rejects` is deprecated. Always explicitly `await` the `expect().rejects` expression.
:::

## Coverage

Coverage is collected with `@vitest/coverage-v8`:

- **Included:** `src/**/*.ts`
- **Excluded:** `*.module.ts`, `*.d.ts`, `index.ts`, `*.interface.ts`, `*.type.ts`
- **Reporters:** `text` (terminal), `lcov`, `html`
- **CI:** Uploaded to [Codecov](https://codecov.io/) on every push

Run `pnpm test:cov` and open `coverage/index.html` for the HTML report.

## Adding a New Integration Test

1. Create `test/integration/my-feature.spec.ts`
2. Follow the container lifecycle pattern (see [How It Works](#how-it-works))
3. Use `uniqueServiceName()` per test to avoid collisions
4. Clean up streams in `afterEach` — even though each suite gets its own NATS, cleanup prevents intra-suite leaks
5. Use `try/finally` in `afterAll` so `container.stop()` always runs even if `nc.drain()` fails
6. Run `pnpm test` — your suite will execute in parallel with others

## Vitest Configuration

The config uses Vitest [projects](https://vitest.dev/guide/projects) to run unit and integration tests with different settings. See `vitest.config.ts` in the repository root.
