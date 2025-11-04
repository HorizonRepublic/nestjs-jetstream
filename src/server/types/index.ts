import { ConsumerConfig, StreamConfig } from 'nats/lib/jetstream/jsapi_types';

import { JetStreamKind } from '../../enum';

export type StreamConfigRecord = {
  base: StreamConfig;
} & Record<JetStreamKind, Partial<StreamConfig>>;

export type ConsumerConfigRecord = Record<
  JetStreamKind,
  (name: string, kind: JetStreamKind) => ConsumerConfig
>;
