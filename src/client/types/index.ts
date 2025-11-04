import { ConnectionProvider } from '../../common/connection.provider';
import { IJetstreamTransportOptions } from '../../common/types';

export interface IClientProviders {
  options: IJetstreamTransportOptions;
  connectionProvider: ConnectionProvider;
}
