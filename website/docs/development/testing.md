---
sidebar_position: 1
title: Testing
---

# Testing

The project uses [Vitest](https://vitest.dev/) v4 with a dual-project configuration: **unit tests** run without external dependencies, **integration tests** require a running NATS server.

## Test Commands

| Command | Description |
|---------|-------------|
| `pnpm test` | Run all tests (unit + integration) once |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm test:cov` | Run all tests with coverage reporting |

## Test Suites

### Unit Tests

- **Location:** `src/**/*.spec.ts`, `src/**/*.test.ts`
- **Setup file:** `test/setup-unit.ts`
- **Timeout:** 10 seconds per test
- **Environment:** Node.js

Unit tests mock all external dependencies and test individual classes/functions in isolation.

### Integration Tests

- **Location:** `test/**/*.spec.ts`
- **Timeout:** 30 seconds per test
- **File parallelism:** Disabled (tests run sequentially)
- **Requirement:** A running NATS server with JetStream enabled

Integration tests verify end-to-end behavior including stream/consumer provisioning, message publishing, RPC round-trips, and dead-letter queue handling.

## Running NATS Locally

Start a NATS server with JetStream enabled for integration tests:

```bash
docker run -d --name nats -p 4222:4222 nats:latest -js
```

To stop and remove the container:

```bash
docker stop nats && docker rm nats
```

:::tip
If you already have NATS running on a non-default port, set the `NATS_URL` environment variable before running tests (if the test setup supports it). Otherwise, integration tests default to `nats://localhost:4222`.
:::

## Test Conventions

The project follows consistent conventions across all test files:

### System Under Test (`sut`)

The object being tested is always named `sut`:

```typescript
let sut: StreamProvider;

beforeEach(() => {
  sut = new StreamProvider(mockOptions, mockConnection);
});
```

### Mocking with `createMock<T>()`

Use `createMock<T>()` from `@golevelup/ts-vitest` to create type-safe mocks:

```typescript
import { createMock } from '@golevelup/ts-vitest';

const mockConnection = createMock<ConnectionProvider>();
```

:::caution
`createMock<JsMsg>()` creates a Proxy object where `'ack' in proxy` returns `false` unless you explicitly provide the `ack` property. If your code checks for property existence on `JsMsg`, provide it in the mock setup.
:::

### Fake Data with `@faker-js/faker`

Use `@faker-js/faker` to generate realistic test data instead of hardcoded strings:

```typescript
import { faker } from '@faker-js/faker';

const serviceName = faker.word.noun();
const pattern = `${faker.word.noun()}.${faker.word.verb()}`;
```

### Given-When-Then Structure

Organize test descriptions with the Given-When-Then pattern:

```typescript
describe('StreamProvider', () => {
  describe('ensureStreams', () => {
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
  });
});
```

### Test Ordering

Tests within a `describe` block follow this order:

1. **Happy path** — the expected successful behavior
2. **Edge cases** — boundary conditions and unusual inputs
3. **Error cases** — failure modes and error handling

### Mock Reset

Always reset mocks after each test to prevent state leakage:

```typescript
afterEach(() => {
  vi.resetAllMocks();
});
```

### Assertions

Use `await expect(...).rejects` for testing async errors:

```typescript
await expect(sut.connect()).rejects.toThrow('Connection refused');
```

:::warning
Vitest auto-await for `.rejects` is deprecated. Always explicitly `await` the `expect().rejects` expression.
:::

## Coverage Reporting

Coverage is collected with `@vitest/coverage-v8` and includes:

- **Included:** `src/**/*.ts`
- **Excluded:** `*.module.ts`, `*.d.ts`, `index.ts`, `*.interface.ts`, `*.type.ts`
- **Reporters:** `text` (terminal), `lcov`, `html`
- **Output directory:** `./coverage`

Run `pnpm test:cov` and open `coverage/index.html` in a browser to view the HTML report.

## Vitest Configuration

The test configuration uses Vitest [projects](https://vitest.dev/guide/projects) to run unit and integration tests with different settings in a single config file. See `vitest.config.ts` in the repository root.
