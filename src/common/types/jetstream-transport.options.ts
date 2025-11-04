import { FactoryProvider, Type } from '@nestjs/common';
import { ModuleMetadata } from '@nestjs/common/interfaces';

import { ServiceType } from '../enum/service-type.enum';

export interface IJetstreamTransportOptions {
  name: string;
  servers: string[];
  serviceType: ServiceType;
}

/**
 * Options for asynchronous JetStream server module configuration.
 *
 * @description
 * Supports three configuration patterns:
 * - `useFactory`: Async factory function with dependency injection
 * - `useExisting`: Reference to an existing options provider
 * - `useClass`: Class that provides options via factory.
 */
export type IJetstreamServerAsyncOptions = {
  /**
   * Service name used for provider token generation.
   * Must be provided upfront for proper dependency injection setup.
   */
  name: string;

  /**
   * Additional imports needed for async configuration.
   * Useful for importing ConfigModule or other services.
   */
  imports?: ModuleMetadata['imports'];
} & (
  | {
      /**
       * Factory function to create options asynchronously.
       * Receives injected dependencies and returns options or a promise.
       */
      useFactory(
        ...args: unknown[]
      ):
        | Promise<Omit<IJetstreamTransportOptions, 'serviceType'>>
        | Omit<IJetstreamTransportOptions, 'serviceType'>;

      /**
       * Dependencies to inject into the factory function.
       */
      inject?: FactoryProvider['inject'];

      useExisting?: never;
      useClass?: never;
    }
  | {
      /**
       * Existing provider token to use for configuration.
       * The provider must return IJetstreamTransportOptions.
       */
      useExisting: Type<Omit<IJetstreamTransportOptions, 'serviceType'>>;

      useFactory?: never;
      inject?: never;
      useClass?: never;
    }
  | {
      /**
       * Class to instantiate for configuration.
       * The class must return IJetstreamTransportOptions when instantiated.
       */
      useClass: Type<Omit<IJetstreamTransportOptions, 'serviceType'>>;

      useFactory?: never;
      inject?: never;
      useExisting?: never;
    }
);
