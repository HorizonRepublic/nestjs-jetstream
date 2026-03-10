import { isObservable, Observable } from 'rxjs';

/**
 * Unwrap a handler result that may be a Promise, Observable, or plain value.
 *
 * - Observable → resolves with the first emitted value
 * - Promise → awaits it
 * - Plain value → returns as-is
 *
 * Used by both CoreRpcServer and RpcRouter to normalize handler output.
 */
export const unwrapResult = async (result: unknown): Promise<unknown> => {
  // Unwrap Observable (take first value)
  if (isObservable(result)) {
    return new Promise((resolve, reject) => {
      let resolved = false;

      (result as Observable<unknown>).subscribe({
        next: (val: unknown) => {
          if (!resolved) {
            resolved = true;
            resolve(val);
          }
        },
        error: reject,
        complete: () => {
          if (!resolved) resolve(undefined);
        },
      });
    });
  }

  return result;
};
