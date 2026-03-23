import { isObservable, Observable, Subscription } from 'rxjs';

/**
 * Unwrap a handler result that may be a Promise, Observable, or nested combination.
 *
 * NestJS-wrapped handlers may return `Promise<Observable>` (e.g. when exception
 * filters convert errors to `throwError()` Observables). This function handles:
 *
 * - `Observable` — subscribe immediately (no await — preserves sync emissions)
 * - `Promise<Observable>` — await Promise, then subscribe
 * - `Promise<value>` — await
 * - Plain value — return as-is
 *
 * @param result - The raw handler return value.
 * @returns The resolved value after unwrapping all layers.
 */
export const unwrapResult = async (result: unknown): Promise<unknown> => {
  // Direct Observable — subscribe immediately (no microtask yield)
  if (isObservable(result)) {
    return subscribeToFirst(result as Observable<unknown>);
  }

  // Await Promise, then check if it resolved to an Observable
  // (NestJS-wrapped handlers return Promise<Observable> when exception filters fire)
  const resolved = await result;

  if (isObservable(resolved)) {
    return subscribeToFirst(resolved as Observable<unknown>);
  }

  return resolved;
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
          // Unsubscribe if subscribe() has already returned; otherwise deferred below
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
