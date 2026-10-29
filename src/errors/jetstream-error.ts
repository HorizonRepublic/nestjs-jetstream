import type { JetstreamErrorLike, JetstreamErrorReason } from './errors.types';

/** Global symbol, so errors thrown by the CJS and ESM builds recognize each other. */
export const JETSTREAM_ERROR_BRAND: unique symbol = Symbol.for(
  '@horizon-republic/nestjs-jetstream/error',
);

export const brandJetstreamError = (error: Error): void => {
  Object.defineProperty(error, JETSTREAM_ERROR_BRAND, { value: true });
};

/** True for any typed transport error, including one from another copy of the package. */
export const isJetstreamError = (value: unknown): value is JetstreamErrorLike =>
  typeof value === 'object' && value !== null && Reflect.get(value, JETSTREAM_ERROR_BRAND) === true;

/** Base of the typed transport errors; `reason` tells why it was thrown. */
export abstract class JetstreamBaseError<TReason extends JetstreamErrorReason> extends Error {
  protected constructor(
    public readonly reason: TReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    brandJetstreamError(this);
  }
}
