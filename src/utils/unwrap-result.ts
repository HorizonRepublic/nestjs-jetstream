import { isObservable, Observable, Subscription } from 'rxjs';

const RESOLVED_VOID = Promise.resolve(undefined);
const RESOLVED_NULL = Promise.resolve(null);

/**
 * Unwrap a handler result that may be a Promise, Observable, or nested combination.
 *
 * NestJS-wrapped handlers may return `Promise<Observable>` (e.g. when exception
 * filters convert errors to `throwError()` Observables). This function handles:
 *
 * - `Observable` — subscribe immediately (no await — preserves sync emissions)
 * - `Promise<Observable>` — await Promise, then subscribe
 * - `Promise<value>` — await
 * - `undefined` / `null` — fast path, no microtask
 *
 * Non-async to avoid an extra microtask tick on the hot path.
 *
 * @param result - The raw handler return value.
 * @returns The resolved value after unwrapping all layers.
 */
export const unwrapResult = (result: unknown): Promise<unknown> => {
  // Fast path: void handlers (most common case)
  if (result === undefined) return RESOLVED_VOID;
  if (result === null) return RESOLVED_NULL;

  // Direct Observable — subscribe immediately (no microtask yield)
  if (isObservable(result)) {
    return subscribeToFirst(result as Observable<unknown>);
  }

  // Thenable (Promise) — check if it resolves to an Observable
  if (typeof (result as Promise<unknown>).then === 'function') {
    return (result as Promise<unknown>).then((resolved) =>
      isObservable(resolved) ? subscribeToFirst(resolved as Observable<unknown>) : resolved,
    );
  }

  // Sync non-null value
  return Promise.resolve(result);
};

/** Subscribe to an Observable and resolve with its first emitted value. */
const subscribeToFirst = (obs: Observable<unknown>): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let done = false;
    let subscription: Subscription | null = null;

    subscription = obs.subscribe({
      next: (val: unknown) => {
        if (!done) {
          done = true;
          resolve(val);
          subscription?.unsubscribe();
        }
      },
      error: (err: unknown) => {
        if (!done) {
          done = true;
          reject(err);
        }
      },
      complete: () => {
        if (!done) resolve(undefined);
      },
    });

    // Handle synchronous emission: next fired before subscribe() returned
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated in sync callback above
    if (done) {
      subscription.unsubscribe();
    }
  });
