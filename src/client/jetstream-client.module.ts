import { DynamicModule, Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { CustomClientOptions } from '@nestjs/microservices/interfaces/client-metadata.interface';

import { ConnectionProvider } from '../common/connection.provider';
import { ServiceType } from '../common/enum/service-type.enum';
import { getJetStreamClientOptionsToken, getToken } from '../common/helpers';
import { IJetstreamTransportOptions } from '../common/types';

import { JetstreamClientProxy } from './jetstream.client-proxy';
import { IClientProviders } from './types';

@Module({})
export class JetstreamClientModule {
  public static forFeature(
    options: Omit<IJetstreamTransportOptions, 'serviceType'>,
  ): DynamicModule {
    return {
      module: JetstreamClientModule,
      imports: [
        ClientsModule.registerAsync({
          clients: [
            {
              name: options.name,
              extraProviders: [
                {
                  provide: getJetStreamClientOptionsToken(options.name),
                  useValue: {
                    ...options,
                    name: `${options.name}__microservice`,
                    serviceType: ServiceType.Producer,
                  },
                },

                {
                  provide: getToken.connection(options.name),
                  inject: [getJetStreamClientOptionsToken(options.name)],
                  useFactory: (options: IJetstreamTransportOptions): ConnectionProvider => {
                    return new ConnectionProvider(options);
                  },
                },
              ],

              inject: [
                getJetStreamClientOptionsToken(options.name),
                getToken.connection(options.name),
              ],
              useFactory: (
                options: IJetstreamTransportOptions,
                connectionProvider: ConnectionProvider,
              ): CustomClientOptions => {
                return {
                  customClass: JetstreamClientProxy,
                  options: {
                    options,
                    connectionProvider,
                  } satisfies IClientProviders,
                };
              },
            },
          ],
        }),
      ],
      exports: [ClientsModule],
    };
  }
}
