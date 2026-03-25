import {
  DynamicModule,
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
  Optional,
  Provider,
} from '@nestjs/common';

import { JetstreamClient } from './client';
import { JsonCodec } from './codec';
import { ConnectionProvider } from './connection';
import { EventBus } from './hooks';
import { JetstreamHealthIndicator } from './health';
import type {
  Codec,
  JetstreamFeatureOptions,
  JetstreamModuleAsyncOptions,
  JetstreamModuleOptions,
} from './interfaces';
import {
  DEFAULT_SHUTDOWN_TIMEOUT,
  getClientToken,
  JETSTREAM_CODEC,
  JETSTREAM_CONNECTION,
  JETSTREAM_EVENT_BUS,
  JETSTREAM_OPTIONS,
} from './jetstream.constants';
import {
  CoreRpcServer,
  ConsumerProvider,
  EventRouter,
  JetstreamStrategy,
  MessageProvider,
  PatternRegistry,
  RpcRouter,
  StreamProvider,
} from './server';
import type { DeadLetterConfig } from './server';
import { ShutdownManager } from './shutdown';

/**
 * Root module for the NestJS JetStream transport.
 *
 * - `forRoot()` / `forRootAsync()` — registers once in AppModule.
 *   Creates shared NATS connection, codec, event bus, and optionally
 *   the consumer infrastructure.
 *
 * - `forFeature()` — registers in feature modules.
 *   Creates a lightweight client proxy targeting a specific service.
 *
 * @example
 * ```typescript
 * // AppModule — global setup
 * @Module({
 *   imports: [
 *     JetstreamModule.forRoot({
 *       name: 'orders',
 *       servers: ['nats://localhost:4222'],
 *     }),
 *   ],
 * })
 * export class AppModule {}
 *
 * // Feature module — per-service clients
 * @Module({
 *   imports: [
 *     JetstreamModule.forFeature({ name: 'users' }),
 *     JetstreamModule.forFeature({ name: 'payments' }),
 *   ],
 * })
 * export class OrdersModule {}
 * ```
 */
@Global()
@Module({})
export class JetstreamModule implements OnApplicationShutdown {
  public constructor(
    @Optional()
    @Inject(ShutdownManager)
    private readonly shutdownManager?: ShutdownManager,
    @Optional() @Inject(JetstreamStrategy) private readonly strategy?: JetstreamStrategy | null,
  ) {}

  // -------------------------------------------------------------------
  // forRoot — global module registration
  // -------------------------------------------------------------------

  /**
   * Register the JetStream transport globally.
   *
   * Creates a shared NATS connection, codec, event bus, and optionally
   * the full consumer infrastructure (streams, consumers, routers).
   *
   * @param options Module configuration.
   * @returns Dynamic module ready to be imported.
   */
  public static forRoot(options: JetstreamModuleOptions): DynamicModule {
    const providers = this.createCoreProviders(options);

    return {
      module: JetstreamModule,
      global: true,
      providers,
      exports: [
        JETSTREAM_CONNECTION,
        JETSTREAM_CODEC,
        JETSTREAM_EVENT_BUS,
        JETSTREAM_OPTIONS,
        ShutdownManager,
        JetstreamStrategy,
        JetstreamHealthIndicator,
      ],
    };
  }

  // -------------------------------------------------------------------
  // forRootAsync — async global module registration
  // -------------------------------------------------------------------

  /**
   * Register the JetStream transport globally with async configuration.
   *
   * Supports `useFactory`, `useExisting`, and `useClass` patterns
   * for loading configuration from ConfigService, environment, etc.
   *
   * @param asyncOptions Async configuration.
   * @returns Dynamic module ready to be imported.
   */
  public static forRootAsync(asyncOptions: JetstreamModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncOptionsProvider(asyncOptions);
    const coreProviders = this.createCoreDependentProviders();

    return {
      module: JetstreamModule,
      global: true,
      imports: asyncOptions.imports ?? [],
      providers: [...asyncProviders, ...coreProviders],
      exports: [
        JETSTREAM_CONNECTION,
        JETSTREAM_CODEC,
        JETSTREAM_EVENT_BUS,
        JETSTREAM_OPTIONS,
        ShutdownManager,
        JetstreamStrategy,
        JetstreamHealthIndicator,
      ],
    };
  }

  // -------------------------------------------------------------------
  // forFeature — per-module client registration
  // -------------------------------------------------------------------

  /**
   * Register a lightweight client proxy for a target service.
   *
   * Reuses the shared NATS connection from `forRoot()`.
   * Import in each feature module that needs to communicate with a specific service.
   *
   * @param options Feature options with target service name.
   * @returns Dynamic module with the client provider.
   */
  public static forFeature(options: JetstreamFeatureOptions): DynamicModule {
    const clientToken = getClientToken(options.name);

    const clientProvider: Provider = {
      provide: clientToken,
      inject: [JETSTREAM_OPTIONS, JETSTREAM_CONNECTION, JETSTREAM_CODEC, JETSTREAM_EVENT_BUS],
      useFactory: (
        rootOptions: JetstreamModuleOptions,
        connection: ConnectionProvider,
        rootCodec: Codec,
        eventBus: EventBus,
      ) => {
        const codec = options.codec ?? rootCodec;

        return new JetstreamClient(rootOptions, options.name, connection, codec, eventBus);
      },
    };

    return {
      module: JetstreamModule,
      providers: [clientProvider],
      exports: [clientToken],
    };
  }

  // -------------------------------------------------------------------
  // Provider factories
  // -------------------------------------------------------------------

  private static createCoreProviders(options: JetstreamModuleOptions): Provider[] {
    return [
      {
        provide: JETSTREAM_OPTIONS,
        useValue: options,
      },
      ...this.createCoreDependentProviders(),
    ];
  }

  /** Create providers that depend on JETSTREAM_OPTIONS (shared by sync and async). */
  private static createCoreDependentProviders(): Provider[] {
    return [
      // EventBus — hook system with Logger fallback
      {
        provide: JETSTREAM_EVENT_BUS,
        inject: [JETSTREAM_OPTIONS],
        useFactory: (options: JetstreamModuleOptions): EventBus => {
          const logger = new Logger('Jetstream:Module');

          return new EventBus(logger, options.hooks);
        },
      },

      // Codec — global encode/decode
      {
        provide: JETSTREAM_CODEC,
        inject: [JETSTREAM_OPTIONS],
        useFactory: (options: JetstreamModuleOptions): Codec => {
          return options.codec ?? new JsonCodec();
        },
      },

      // ConnectionProvider — single NATS connection
      {
        provide: JETSTREAM_CONNECTION,
        inject: [JETSTREAM_OPTIONS, JETSTREAM_EVENT_BUS],
        useFactory: (options: JetstreamModuleOptions, eventBus: EventBus): ConnectionProvider => {
          return new ConnectionProvider(options, eventBus);
        },
      },

      // JetstreamHealthIndicator — health check for NATS connection
      {
        provide: JetstreamHealthIndicator,
        inject: [JETSTREAM_CONNECTION],
        useFactory: (connection: ConnectionProvider): JetstreamHealthIndicator => {
          return new JetstreamHealthIndicator(connection);
        },
      },

      // ShutdownManager — graceful shutdown orchestration
      {
        provide: ShutdownManager,
        inject: [JETSTREAM_CONNECTION, JETSTREAM_EVENT_BUS, JETSTREAM_OPTIONS],
        useFactory: (
          connection: ConnectionProvider,
          eventBus: EventBus,
          options: JetstreamModuleOptions,
        ): ShutdownManager => {
          return new ShutdownManager(
            connection,
            eventBus,
            options.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT,
          );
        },
      },

      // ---------------------------------------------------------------
      // Consumer infrastructure — only created when consumer !== false.
      // Providers return null when consumer is disabled (publisher-only mode).
      // ---------------------------------------------------------------

      // PatternRegistry — subject-to-handler mapping
      {
        provide: PatternRegistry,
        inject: [JETSTREAM_OPTIONS],
        useFactory: (options: JetstreamModuleOptions): PatternRegistry | null => {
          if (options.consumer === false) return null;

          return new PatternRegistry(options);
        },
      },

      // StreamProvider — JetStream stream lifecycle
      {
        provide: StreamProvider,
        inject: [JETSTREAM_OPTIONS, JETSTREAM_CONNECTION],
        useFactory: (
          options: JetstreamModuleOptions,
          connection: ConnectionProvider,
        ): StreamProvider | null => {
          if (options.consumer === false) return null;

          return new StreamProvider(options, connection);
        },
      },

      // ConsumerProvider — JetStream consumer lifecycle (receives PatternRegistry for broadcast filtering)
      {
        provide: ConsumerProvider,
        inject: [JETSTREAM_OPTIONS, JETSTREAM_CONNECTION, StreamProvider, PatternRegistry],
        useFactory: (
          options: JetstreamModuleOptions,
          connection: ConnectionProvider,
          streamProvider: StreamProvider,
          patternRegistry: PatternRegistry,
        ): ConsumerProvider | null => {
          if (options.consumer === false) return null;

          return new ConsumerProvider(options, connection, streamProvider, patternRegistry);
        },
      },

      // MessageProvider — pull-based message consumption
      {
        provide: MessageProvider,
        inject: [JETSTREAM_OPTIONS, JETSTREAM_CONNECTION, JETSTREAM_EVENT_BUS],
        useFactory: (
          options: JetstreamModuleOptions,
          connection: ConnectionProvider,
          eventBus: EventBus,
        ): MessageProvider | null => {
          if (options.consumer === false) return null;

          return new MessageProvider(connection, eventBus);
        },
      },

      // EventRouter — routes event and broadcast messages to handlers
      {
        provide: EventRouter,
        inject: [
          JETSTREAM_OPTIONS,
          MessageProvider,
          PatternRegistry,
          JETSTREAM_CODEC,
          JETSTREAM_EVENT_BUS,
        ],
        useFactory: (
          options: JetstreamModuleOptions,
          messageProvider: MessageProvider,
          patternRegistry: PatternRegistry,
          codec: Codec,
          eventBus: EventBus,
        ): EventRouter | null => {
          if (options.consumer === false) return null;

          const deadLetterConfig: DeadLetterConfig | undefined = options.onDeadLetter
            ? {
                maxDeliverByStream: new Map(),
                onDeadLetter: options.onDeadLetter,
              }
            : undefined;

          return new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            deadLetterConfig,
          );
        },
      },

      // RpcRouter — routes RPC command messages in JetStream mode
      {
        provide: RpcRouter,
        inject: [
          JETSTREAM_OPTIONS,
          MessageProvider,
          PatternRegistry,
          JETSTREAM_CONNECTION,
          JETSTREAM_CODEC,
          JETSTREAM_EVENT_BUS,
        ],
        useFactory: (
          options: JetstreamModuleOptions,
          messageProvider: MessageProvider,
          patternRegistry: PatternRegistry,
          connection: ConnectionProvider,
          codec: Codec,
          eventBus: EventBus,
        ): RpcRouter | null => {
          if (options.consumer === false) return null;

          const timeout = options.rpc?.mode === 'jetstream' ? options.rpc.timeout : undefined;

          return new RpcRouter(
            messageProvider,
            patternRegistry,
            connection,
            codec,
            eventBus,
            { timeout },
          );
        },
      },

      // CoreRpcServer — RPC via NATS Core request/reply
      {
        provide: CoreRpcServer,
        inject: [
          JETSTREAM_OPTIONS,
          JETSTREAM_CONNECTION,
          PatternRegistry,
          JETSTREAM_CODEC,
          JETSTREAM_EVENT_BUS,
        ],
        useFactory: (
          options: JetstreamModuleOptions,
          connection: ConnectionProvider,
          patternRegistry: PatternRegistry,
          codec: Codec,
          eventBus: EventBus,
        ): CoreRpcServer | null => {
          if (options.consumer === false) return null;

          return new CoreRpcServer(options, connection, patternRegistry, codec, eventBus);
        },
      },

      // JetstreamStrategy — server-side transport (only when consumer enabled)
      {
        provide: JetstreamStrategy,
        inject: [
          JETSTREAM_OPTIONS,
          JETSTREAM_CONNECTION,
          PatternRegistry,
          StreamProvider,
          ConsumerProvider,
          MessageProvider,
          EventRouter,
          RpcRouter,
          CoreRpcServer,
        ],
        useFactory: (
          options: JetstreamModuleOptions,
          connection: ConnectionProvider,
          patternRegistry: PatternRegistry,
          streamProvider: StreamProvider,
          consumerProvider: ConsumerProvider,
          messageProvider: MessageProvider,
          eventRouter: EventRouter,
          rpcRouter: RpcRouter,
          coreRpcServer: CoreRpcServer,
        ): JetstreamStrategy | null => {
          if (options.consumer === false) return null;

          return new JetstreamStrategy(
            options,
            connection,
            patternRegistry,
            streamProvider,
            consumerProvider,
            messageProvider,
            eventRouter,
            rpcRouter,
            coreRpcServer,
          );
        },
      },
    ];
  }

  /** Create async options provider from useFactory/useExisting/useClass. */
  private static createAsyncOptionsProvider(asyncOptions: JetstreamModuleAsyncOptions): Provider[] {
    if (asyncOptions.useFactory) {
      const factory = asyncOptions.useFactory;

      return [
        {
          provide: JETSTREAM_OPTIONS,
          useFactory: async (...args: unknown[]): Promise<JetstreamModuleOptions> => {
            const partial = await factory(...args);

            return { ...partial, name: asyncOptions.name } satisfies JetstreamModuleOptions;
          },
          inject: asyncOptions.inject ?? [],
        },
      ];
    }

    if (asyncOptions.useExisting) {
      return [
        {
          provide: JETSTREAM_OPTIONS,
          useFactory: (config: Omit<JetstreamModuleOptions, 'name'>): JetstreamModuleOptions => ({
            ...config,
            name: asyncOptions.name,
          }),
          inject: [asyncOptions.useExisting],
        },
      ];
    }

    // useClass — guaranteed by the discriminated union after excluding useFactory and useExisting
    const useClass = asyncOptions.useClass;

    return [
      { provide: useClass, useClass },
      {
        provide: JETSTREAM_OPTIONS,
        useFactory: (config: Omit<JetstreamModuleOptions, 'name'>): JetstreamModuleOptions => ({
          ...config,
          name: asyncOptions.name,
        }),
        inject: [useClass],
      },
    ];
  }

  // -------------------------------------------------------------------
  // Lifecycle hooks
  // -------------------------------------------------------------------

  /**
   * Gracefully shut down the transport on application termination.
   */
  public async onApplicationShutdown(): Promise<void> {
    if (this.shutdownManager) {
      await this.shutdownManager.shutdown(this.strategy ?? undefined);
    }
  }
}
