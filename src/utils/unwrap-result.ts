import { isObservable, Observable, Subscription } from 'rxjs';

/**
 * Unwrap a handler return value into something the transport can settle on.
 *
 * Handler results come in several shapes — sync values, Promises, Observables,
 * and occasionally `Promise<Observable>` when NestJS exception filters convert
 * errors into `throwError()` streams. This function collapses them into either
 * the value itself (for sync results) or a Promise that resolves to the first
 * emitted / resolved value.
 *
 * The return type is `unknown` so callers can check for a thenable with
 * {@link isPromiseLike} and skip the `await` on sync paths. Awaiting a
 * non-thenable still works but costs a microtask.
 */
export const unwrapResult = (result: unknown): unknown => {
  if (result === undefined || result === null) return result;

  if (isObservable(result)) {
    return subscribeToFirst(result as Observable<unknown>);
  }

  if (typeof (result as Promise<unknown>).then === 'function') {
    return (result as Promise<unknown>).then((resolved) =>
      isObservable(resolved) ? subscribeToFirst(resolved as Observable<unknown>) : resolved,
    );
  }

  return result;
};

/** Thenable type guard used to decide whether {@link unwrapResult}'s output needs `await`. */
export const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as PromiseLike<unknown>).then === 'function';

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

    // `next` may have fired synchronously during subscribe() and already
    // flipped `done` — unsubscribe immediately if so.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated in sync callback above
    if (done) {
      subscription.unsubscribe();
    }
  });
