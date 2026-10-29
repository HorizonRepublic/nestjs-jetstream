export const toError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(String(err));

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
