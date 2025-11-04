import { DynamicModule, FactoryProvider, Module, Provider } from '@nestjs/common';

import { ConnectionProvider } from '../common/connection.provider';
import { ServiceType } from '../common/enum/service-type.enum';
import {
  getJetStreamServerOptionsToken,
  getJetStreamTransportToken,
  getToken,
} from '../common/helpers';
import { PatternRegistry } from '../common/pattern-registry';
import { IJetstreamServerAsyncOptions, IJetstreamTransportOptions } from '../common/types';

import { JetstreamStrategy } from './jetstream.strategy';
import { JetstreamTransport } from './jetstream.transport';
import { ConsumerProvider } from './providers/consumer.provider';
import { MessageRoutingProvider } from './providers/message-routing.provider';
import { MessageProvider } from './providers/message.provider';
import { StreamProvider } from './providers/stream.provider';

/**
 * Dynamic module for configuring NATS JetStream server transport in NestJS microservices.
 *
 * @description
 * This module provides a complete NATS JetStream consumer implementation that enables
 * NestJS applications to receive and process messages from JetStream streams. It handles
 * the entire lifecycle of JetStream consumers, including connection management, stream
 * creation, message consumption, and routing to appropriate handlers.
 *
 * @example
 * ```typescript
 * // Single service configuration
 * @Module({
 *   imports: [
 *     JetstreamServerModule.forRoot({
 *       servers: ['nats://localhost:4222'],
 *       name: 'orders-service',
 *     }),
 *   ],
 * })
 * export class AppModule {}
 *
 * // Multiple services in one application
 * @Module({
 *   imports: [
 *     JetstreamServerModule.forRoot({
 *       servers: ['nats://localhost:4222'],
 *       name: 'orders-service',
 *     }),
 *     JetstreamServerModule.forRoot({
 *       servers: ['nats://localhost:4222'],
 *       name: 'notifications-service',
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * @see {@link https://docs.nestjs.com/microservices/nats | NestJS NATS Microservices}
 * @see {@link https://docs.nats.io/nats-concepts/jetstream | NATS JetStream Documentation}
 */
@Module({})
export class JetstreamServerModule {
  /**
   * Configures the JetStream server module with the provided options.
   *
   * @description
   * Creates a dynamic module with all necessary providers for JetStream message consumption.
   * The module automatically:
   * - Establishes a NATS connection
   * - Creates or updates JetStream streams for events and commands
   * - Creates durable consumers for reliable message delivery
   * - Routes incoming messages to registered handlers
   * - Handles reconnections and failures gracefully.
   *
   * Each provider is registered with a unique token based on the service name, ensuring
   * that multiple server instances can coexist without conflicts.
   *
   * @param options Configuration options for the JetStream server (without serviceType).
   * @returns A dynamic module configuration ready to be imported.
   *
   * @example
   * ```typescript
   * JetstreamServerModule.forRoot({
   *   servers: ['nats://localhost:4222'],
   *   name: 'orders-service',
   * })
   * ```
   */
  public static forRoot(options: Omit<IJetstreamTransportOptions, 'serviceType'>): DynamicModule {
    const providers = this.createProviders(options);

    return {
      module: JetstreamServerModule,
      providers: [
        {
          provide: getJetStreamServerOptionsToken(options.name),
          useValue: {
            ...options,
            name: `${options.name}__microservice`,
            serviceType: ServiceType.Consumer,
          },
        } satisfies Provider<IJetstreamTransportOptions>,
        ...providers,
      ],
      exports: [getJetStreamTransportToken(options.name)],
    };
  }

  /**
   * Asynchronously configures the JetStream server module.
   *
   * @description
   * Allows configuration to be loaded asynchronously, useful for scenarios where
   * options need to be retrieved from configuration services, databases, or
   * environment variables at runtime.
   *
   * Supports three configuration patterns:
   * - **useFactory**: Most flexible, allows async operations and dependency injection
   * - **useExisting**: References an existing provider in the module
   * - **useClass**: Instantiates a class that provides the configuration.
   *
   * @param asyncOptions Async configuration options.
   * @returns A dynamic module configuration with async providers.
   *
   * @example
   * ```typescript
   * // Using factory with ConfigService
   * JetstreamServerModule.forRootAsync({
   *   name: 'orders-service',
   *   imports: [ConfigModule],
   *   useFactory: (configService: ConfigService) => ({
   *     servers: configService.get<string[]>('NATS_SERVERS'),
   *     name: configService.get<string>('SERVICE_NAME'),
   *   }),
   *   inject: [ConfigService],
   * })
   *
   * // Using existing provider
   * const JETSTREAM_CONFIG = 'JETSTREAM_CONFIG';
   *
   * @Module({
   *   providers: [{
   *     provide: JETSTREAM_CONFIG,
   *     useValue: { servers: ['nats://localhost:4222'], name: 'my-service' },
   *   }],
   *   exports: [JETSTREAM_CONFIG],
   * })
   * class ConfigModule {}
   *
   * JetstreamServerModule.forRootAsync({
   *   name: 'orders-service',
   *   imports: [ConfigModule],
   *   useExisting: JETSTREAM_CONFIG,
   * })
   *
   * // Using class
   * @Injectable()
   * class JetstreamConfig {
   *   servers = ['nats://localhost:4222'];
   *   name = 'my-service';
   * }
   *
   * JetstreamServerModule.forRootAsync({
   *   name: 'orders-service',
   *   useClass: JetstreamConfig,
   * })
   * ```
   */
  public static forRootAsync(asyncOptions: IJetstreamServerAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(asyncOptions);
    const providers = this.createProviders({ name: asyncOptions.name } as Omit<
      IJetstreamTransportOptions,
      'serviceType'
    >);

    return {
      module: JetstreamServerModule,
      imports: asyncOptions.imports ?? [],
      providers: [...asyncProviders, ...providers],
      exports: [getJetStreamTransportToken(asyncOptions.name)],
    };
  }

  /**
   * Creates async configuration providers based on the provided options.
   *
   * @description
   * Generates the appropriate provider configuration for async module setup.
   * Handles all three async patterns: useFactory, useExisting, and useClass.
   *
   * @param options Async configuration options.
   * @returns Array of providers for async configuration.
   */
  private static createAsyncProviders(options: IJetstreamServerAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: getJetStreamServerOptionsToken(options.name),
          useFactory: (
            ...args: unknown[]
          ): Promise<IJetstreamTransportOptions> | IJetstreamTransportOptions => {
            const result = options.useFactory(...args);

            if (result instanceof Promise) {
              return result.then((config) => ({
                ...config,
                name: `${options.name}__microservice`,
                serviceType: ServiceType.Consumer,
              }));
            }

            return {
              ...result,
              name: `${options.name}__microservice`,
              serviceType: ServiceType.Consumer,
            };
          },
          inject: options.inject ?? [],
        } satisfies FactoryProvider<
          Promise<IJetstreamTransportOptions> | IJetstreamTransportOptions
        >,
      ];
    }

    if (options.useExisting) {
      return [
        {
          provide: getJetStreamServerOptionsToken(options.name),
          useFactory: (
            config: Omit<IJetstreamTransportOptions, 'serviceType'>,
          ): IJetstreamTransportOptions => ({
            ...config,
            name: `${options.name}__microservice`,
            serviceType: ServiceType.Consumer,
          }),
          inject: [options.useExisting],
        } satisfies FactoryProvider<IJetstreamTransportOptions>,
      ];
    }

    return [
      {
        provide: options.useClass,
        useClass: options.useClass,
      },
      {
        provide: getJetStreamServerOptionsToken(options.name),
        useFactory: (
          config: Omit<IJetstreamTransportOptions, 'serviceType'>,
        ): IJetstreamTransportOptions => ({
          ...config,
          name: `${options.name}__microservice`,
          serviceType: ServiceType.Consumer,
        }),
        inject: [options.useClass],
      } satisfies FactoryProvider<IJetstreamTransportOptions>,
    ];
  }

  /**
   * Creates all required providers for the JetStream server.
   *
   * @description
   * Generates the complete provider tree for a JetStream server instance.
   * This method is shared between forRoot and forRootAsync to ensure
   * consistent provider configuration.
   *
   * @param options JetStream transport options (partial for async case).
   * @returns Array of all required providers.
   */
  private static createProviders(options: Pick<IJetstreamTransportOptions, 'name'>): Provider[] {
    return [
      // ============================================================
      // Infrastructure Layer
      // ============================================================

      /**
       * NATS connection provider.
       * Manages the underlying NATS connection lifecycle, including
       * connect/disconnect/reconnect events and graceful shutdown.
       */
      {
        provide: getToken.connection(options.name),
        inject: [getJetStreamServerOptionsToken(options.name)],
        useFactory: (options: IJetstreamTransportOptions): ConnectionProvider =>
          new ConnectionProvider(options),
      } satisfies FactoryProvider<ConnectionProvider>,

      /**
       * JetStream stream provider.
       * Ensures that required JetStream streams exist and are properly
       * configured for both event and command message types.
       */
      {
        provide: getToken.stream(options.name),
        inject: [getJetStreamServerOptionsToken(options.name), getToken.connection(options.name)],
        useFactory: (
          options: IJetstreamTransportOptions,
          connection: ConnectionProvider,
        ): StreamProvider => {
          return new StreamProvider(options, connection);
        },
      } satisfies FactoryProvider<StreamProvider>,

      // ============================================================
      // Consumer Layer
      // ============================================================

      /**
       * JetStream consumer provider.
       * Creates and manages durable consumers for pulling messages
       * from JetStream streams with acknowledgment support.
       */
      {
        provide: getToken.consumer(options.name),
        inject: [
          getJetStreamServerOptionsToken(options.name),
          getToken.connection(options.name),
          getToken.stream(options.name),
        ],
        useFactory: (
          options: IJetstreamTransportOptions,
          connection: ConnectionProvider,
          stream: StreamProvider,
        ): ConsumerProvider => new ConsumerProvider(options, connection, stream),
      } satisfies FactoryProvider<ConsumerProvider>,

      // ============================================================
      // Message Layer
      // ============================================================

      /**
       * Message provider.
       * Handles low-level message consumption from JetStream consumers,
       * including message acknowledgment and error handling.
       */
      {
        provide: getToken.message(options.name),
        inject: [getToken.connection(options.name), getToken.consumer(options.name)],
        useFactory: (
          connection: ConnectionProvider,
          consumer: ConsumerProvider,
        ): MessageProvider => {
          return new MessageProvider(connection, consumer);
        },
      } satisfies FactoryProvider<MessageProvider>,

      // ============================================================
      // Application Layer
      // ============================================================

      /**
       * Pattern registry.
       * Maps NATS subjects to NestJS message handlers registered via.
       */
      {
        provide: getToken.patternRegistry(options.name),
        inject: [getJetStreamServerOptionsToken(options.name), getToken.strategy(options.name)],
        useFactory: (
          options: IJetstreamTransportOptions,
          strategy: JetstreamStrategy,
        ): PatternRegistry => {
          return new PatternRegistry(options, strategy);
        },
      } satisfies FactoryProvider<PatternRegistry>,

      /**
       * Message routing provider.
       * Routes incoming messages to appropriate handlers based on
       * subject patterns and handles response serialization.
       */
      {
        provide: getToken.messageRouting(options.name),
        inject: [
          getToken.connection(options.name),
          getToken.message(options.name),
          getToken.patternRegistry(options.name),
        ],
        useFactory: (
          connection: ConnectionProvider,
          message: MessageProvider,
          patternRegistry: PatternRegistry,
        ): MessageRoutingProvider =>
          new MessageRoutingProvider(connection, message, patternRegistry),
      } satisfies FactoryProvider<MessageRoutingProvider>,

      // ============================================================
      // Transport Layer
      // ============================================================

      /**
       * JetStream transport strategy.
       * Coordinates all providers to implement the NestJS CustomTransportStrategy
       * interface and manage the complete message processing lifecycle.
       */
      {
        provide: getToken.strategy(options.name),
        inject: [
          getToken.connection(options.name),
          getToken.stream(options.name),
          getToken.consumer(options.name),
        ],
        useFactory: (
          connection: ConnectionProvider,
          stream: StreamProvider,
          consumer: ConsumerProvider,
        ): JetstreamStrategy => new JetstreamStrategy(connection, stream, consumer),
      } satisfies FactoryProvider<JetstreamStrategy>,

      /**
       * JetStream transport wrapper.
       * Main entry point that combines options and strategy into
       * a CustomStrategy implementation for NestJS microservices.
       */
      {
        provide: getJetStreamTransportToken(options.name),
        inject: [getJetStreamServerOptionsToken(options.name), getToken.strategy(options.name)],
        useFactory: (
          options: IJetstreamTransportOptions,
          strategy: JetstreamStrategy,
        ): JetstreamTransport => {
          return new JetstreamTransport(options, strategy);
        },
      } satisfies FactoryProvider<JetstreamTransport>,
    ];
  }
}
