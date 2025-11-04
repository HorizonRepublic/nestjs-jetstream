import { Injectable } from '@nestjs/common';
import { CustomStrategy } from '@nestjs/microservices';

import { IJetstreamTransportOptions } from '../common/types';

import { JetstreamStrategy } from './jetstream.strategy';

@Injectable()
export class JetstreamTransport implements CustomStrategy {
  public constructor(
    public readonly options: IJetstreamTransportOptions,
    public readonly strategy: JetstreamStrategy,
  ) {}
}
