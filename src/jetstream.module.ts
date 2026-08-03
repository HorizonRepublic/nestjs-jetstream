import {
  DynamicModule,
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
  Provider,
} from '@nestjs/common';

import { JetstreamClient } from './client';
import { JsonCodec } from './codec';
import { ConnectionRegistry, createConnectionScope, normalizeOptions } from './connection';
import type { ConnectionProvider } from './connection/connection.provider';
import type { ConnectionSharedContext } from './connection/connection.types';
import { JetstreamHealthIndicator } from './health';
import { EventBus } from './hooks';
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
  JETSTREAM_CONNECTIONS,
  JETSTREAM_EVENT_BUS,
  JETSTREAM_OPTIONS,
} from './jetstream.constants';
import { JetstreamMetricsModule } from './metrics/metrics.module';
import { JetstreamStrategy, PatternRegistry } from './server';
import { NameResolver } from './server/infrastructure/name-resolver';
import { ShutdownManager } from './shutdown';

export {
  DESTRUCTIVE_MIGRATION_MANUAL_WARNING,
  warnIfManualWithDestructive,
} from './server/infrastructure/provisioning-warnings';

/**
 * Root module for the NestJS JetStream transport.
 *
 * - `forRoot()` / `forRootAsync()`: registers once in AppModule.
 *   Creates shared NATS connection, codec, event bus, and optionally
 *   the consumer infrastructure.
 *
 * - `forFeature()`: registers in feature modules.
 *   Creates a lightweight client proxy targeting a specific service.
 *
 * @example
 * ```typescript
 * // AppModule: global setup
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
 * // Feature module: per-service clients
 * @Module({
 *   imports: [
 *     JetstreamModule.forFeature({ name: 'users' }),
 *     JetstreamModule.forFeature({ name: 'payments' }),
 *   ],
 * })
 * export class OrdersModule {}
 * ```
 */
/**
 * Fail when a configured connection never had `listen()` called.
 *
 * Without this a second connection's handlers are registered but never
 * subscribed, so its messages are silently not processed. Skipped for
 * single-connection applications, which may legitimately run without a hybrid
 * bootstrap.
 *
 * @param registry Every configured connection.
 * @throws Error naming the connections that never started.
 */
export const assertAllConnectionsStarted = (registry: ConnectionRegistry): void => {
  if (registry.names().length < 2) return;

  const unstarted = registry
    .all()
    .filter((scope) => scope.strategy !== null && !scope.strategy.isStarted)
    .map((scope) => scope.name);

  if (unstarted.length === 0) return;

  throw new Error(
    `Connections never started: ${unstarted.join(', ')}. ` +
      `Their handlers are registered but not subscribed, so messages are silently not processed. ` +
      `Call connectJetstreamMicroservices(app) before app.startAllMicroservices().`,
  );
};

/**
 * Open every critical connection before the application is considered started.
 *
 * A connection with no handlers never touches NATS on its own — the boot chain
 * only provisions what handlers require — so without this `critical: true`
 * would have no effect on a publish-only connection, which is precisely the
 * case it exists for.
 *
 * Skipped for single-connection applications so a publisher-only service keeps
 * its lazy-connect behaviour and still boots while NATS is down.
 *
 * @param registry Every configured connection.
 * @throws Error when a critical connection cannot be reached.
 */
export const ensureCriticalConnectionsLive = async (
  registry: ConnectionRegistry,
): Promise<void> => {
  if (registry.names().length < 2) return;

  await Promise.all(
    registry
      .all()
      .filter((scope) => scope.critical)
      .map(async (scope) => {
        await scope.connection.getConnection();
      }),
  );
};

@Global()
@Module({})
export class JetstreamModule implements OnApplicationBootstrap, OnApplicationShutdown {
  public constructor(
    @Optional()
    @Inject(ShutdownManager)
    private readonly shutdownManager?: ShutdownManager | undefined,
    @Optional()
    @Inject(JETSTREAM_CONNECTIONS)
    private readonly registry?: ConnectionRegistry | undefined,
  ) {}

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
      imports: [JetstreamMetricsModule.forFeature()],
      providers,
      exports: [
        JETSTREAM_CONNECTION,
        JETSTREAM_CONNECTIONS,
        JETSTREAM_CODEC,
        JETSTREAM_EVENT_BUS,
        JETSTREAM_OPTIONS,
        PatternRegistry,
        ShutdownManager,
        JetstreamStrategy,
        JetstreamHealthIndicator,
        NameResolver,
      ],
    };
  }

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
      imports: [...(asyncOptions.imports ?? []), JetstreamMetricsModule.forFeature()],
      providers: [...asyncProviders, ...coreProviders],
      exports: [
        JETSTREAM_CONNECTION,
        JETSTREAM_CONNECTIONS,
        JETSTREAM_CODEC,
        JETSTREAM_EVENT_BUS,
        JETSTREAM_OPTIONS,
        PatternRegistry,
        ShutdownManager,
        JetstreamStrategy,
        JetstreamHealthIndicator,
        NameResolver,
      ],
    };
  }

  /**
   * Register a lightweight client proxy for a target service.
   *
   * Reuses the NATS connection from `forRoot()`. Import in each feature module
   * that needs to communicate with a specific service. Pass `connection` to
   * publish on a named connection instead of the default one.
   *
   * @param options Feature options with target service name.
   * @returns Dynamic module with the client provider.
   */
  public static forFeature(options: JetstreamFeatureOptions): DynamicModule {
    const clientToken = getClientToken(options.name, options.connection);

    const clientProvider: Provider = {
      provide: clientToken,
      inject: [JETSTREAM_OPTIONS, JETSTREAM_CONNECTIONS, JETSTREAM_EVENT_BUS],
      useFactory: (
        rootOptions: JetstreamModuleOptions,
        registry: ConnectionRegistry,
        eventBus: EventBus,
      ): JetstreamClient => {
        const scope =
          options.connection === undefined
            ? registry.getDefault()
            : registry.get(options.connection);

        return new JetstreamClient(
          rootOptions,
          options.name,
          scope.connection,
          options.codec ?? scope.codec,
          eventBus,
          scope.names,
        );
      },
    };

    return {
      module: JetstreamModule,
      providers: [clientProvider],
      exports: [clientToken],
    };
  }

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
      {
        provide: JETSTREAM_EVENT_BUS,
        inject: [JETSTREAM_OPTIONS],
        useFactory: (options: JetstreamModuleOptions): EventBus =>
          new EventBus(new Logger('Jetstream:Module'), options.hooks),
      },

      {
        provide: JETSTREAM_CONNECTIONS,
        inject: [JETSTREAM_OPTIONS, JETSTREAM_EVENT_BUS],
        useFactory: (options: JetstreamModuleOptions, eventBus: EventBus): ConnectionRegistry => {
          const normalized = normalizeOptions(options);
          const shared: ConnectionSharedContext = {
            eventBus,
            rootCodec: options.codec ?? new JsonCodec(),
          };

          const known = new Set(normalized.connections.map((c) => c.connectionName));
          const publisherOnly = new Set(
            normalized.connections.filter((c) => c.consumer === false).map((c) => c.connectionName),
          );

          const scopes = new Map(
            normalized.connections.map((connectionOptions) => [
              connectionOptions.connectionName,
              createConnectionScope(connectionOptions, shared, {
                name: connectionOptions.connectionName,
                defaultName: normalized.defaultConnection,
                known,
                publisherOnly,
              }),
            ]),
          );

          return new ConnectionRegistry(scopes, normalized.defaultConnection);
        },
      },

      // Compatibility delegates: the pre-3.0 tokens resolve to the default connection.
      {
        provide: JETSTREAM_CONNECTION,
        inject: [JETSTREAM_CONNECTIONS],
        useFactory: (registry: ConnectionRegistry): ConnectionProvider =>
          registry.getDefault().connection,
      },

      {
        provide: JETSTREAM_CODEC,
        inject: [JETSTREAM_CONNECTIONS],
        useFactory: (registry: ConnectionRegistry): Codec => registry.getDefault().codec,
      },

      {
        provide: NameResolver,
        inject: [JETSTREAM_CONNECTIONS],
        useFactory: (registry: ConnectionRegistry): NameResolver => registry.getDefault().names,
      },

      {
        provide: PatternRegistry,
        inject: [JETSTREAM_CONNECTIONS],
        useFactory: (registry: ConnectionRegistry): PatternRegistry | null =>
          registry.getDefault().patterns,
      },

      {
        provide: JetstreamStrategy,
        inject: [JETSTREAM_CONNECTIONS],
        useFactory: (registry: ConnectionRegistry): JetstreamStrategy | null =>
          registry.getDefault().strategy,
      },

      {
        provide: JetstreamHealthIndicator,
        inject: [JETSTREAM_CONNECTIONS],
        useFactory: (registry: ConnectionRegistry): JetstreamHealthIndicator =>
          new JetstreamHealthIndicator(registry),
      },

      {
        provide: ShutdownManager,
        inject: [JETSTREAM_CONNECTIONS, JETSTREAM_EVENT_BUS, JETSTREAM_OPTIONS],
        useFactory: (
          registry: ConnectionRegistry,
          eventBus: EventBus,
          options: JetstreamModuleOptions,
        ): ShutdownManager =>
          new ShutdownManager(
            registry,
            eventBus,
            options.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT,
          ),
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

    // useClass is guaranteed by the discriminated union after the branches above.
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

  /**
   * Verify every configured connection actually started.
   *
   * Runs after `startAllMicroservices()` in a hybrid application.
   */
  public async onApplicationBootstrap(): Promise<void> {
    if (!this.registry) return;

    assertAllConnectionsStarted(this.registry);
    await ensureCriticalConnectionsLive(this.registry);
  }

  /**
   * Gracefully shut down the transport on application termination.
   */
  public async onApplicationShutdown(): Promise<void> {
    await this.shutdownManager?.shutdown();
  }
}
