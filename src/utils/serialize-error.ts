import { RpcException } from '@nestjs/microservices';

/**
 * Serialize an error for transport over NATS.
 *
 * Handles three cases:
 * 1. `RpcException` — unwraps via `getError()` to preserve the full payload.
 * 2. Generic `Error` — extracts `{ message }` to avoid `"[object Object]"`.
 * 3. Plain object — passed through as-is (already unwrapped by NestJS filters).
 *
 * @param err - The error to serialize.
 * @returns A JSON-safe representation of the error.
 */
export const serializeError = (err: unknown): unknown => {
  if (err instanceof RpcException) return err.getError();
  if (err instanceof Error) return { message: err.message };

  return err;
};
