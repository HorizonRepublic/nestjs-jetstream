import { ManagementMode } from '../../interfaces';
import type { DlqOptions, JetstreamModuleOptions, StreamConfigOverrides } from '../../interfaces';

/**
 * The dead-letter stream is provisioned unless it is explicitly turned off.
 * Leaving it off by default meant a handler that exhausted its attempts
 * dropped the message with nothing to inspect afterwards.
 *
 * The one exception is bind-only mode: a service that provisions nothing
 * cannot be made to fail boot over a stream its operator never asked for, so
 * the implicit default stands down under global Manual management. Configure
 * `dlq` explicitly to bind to an externally provisioned one.
 */
export const isDlqEnabled = (options: JetstreamModuleOptions): boolean => {
  if (options.dlq === false) return false;
  if (options.dlq !== undefined) return true;

  return options.provisioning?.management !== ManagementMode.Manual;
};

/** User overrides for the DLQ stream, empty when the defaults apply. */
export const dlqStreamOverrides = (options: JetstreamModuleOptions): StreamConfigOverrides =>
  (options.dlq === false ? undefined : options.dlq?.stream) ?? {};

/** DLQ provisioning options, or `undefined` when the DLQ is off. */
export const dlqOptions = (options: JetstreamModuleOptions): DlqOptions | undefined =>
  options.dlq === false ? undefined : options.dlq;
