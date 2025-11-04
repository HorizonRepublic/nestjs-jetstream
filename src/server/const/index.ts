/* eslint-disable @typescript-eslint/naming-convention */
import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
  StoreCompression,
} from 'nats';
import { ConsumerConfig } from 'nats/lib/jetstream/jsapi_types';

import { JetStreamKind } from '../../enum';
import { ConsumerConfigRecord, StreamConfigRecord } from '../types';

// Size constants in bytes
const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

// Time constants in nanoseconds (NATS JetStream format)
const SEC = 1e9; // 1s in ns
const MIN = 60 * SEC; // 1m in ns
const HOUR = 60 * MIN; // 1h in ns
const DAY = 24 * HOUR; // 1d in ns

export const streamConfig: StreamConfigRecord = Object.freeze({
  base: {
    name: '',
    subjects: [],
    description: '',
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    num_replicas: 1,

    // Resource limits
    max_consumers: 0,
    max_msgs_per_subject: 0,
    max_msgs: 0,
    max_age: 0,
    max_bytes: 0,
    max_msg_size: 0,

    // Stream behavior settings
    discard: DiscardPolicy.Old,
    discard_new_per_subject: false,
    duplicate_window: 0,
    first_seq: 0,
    sealed: false,
    mirror_direct: false,
    allow_direct: true,
    allow_rollup_hdrs: false,
    deny_delete: false,
    deny_purge: false,
    compression: StoreCompression.None,
  },

  [JetStreamKind.Event]: {
    allow_rollup_hdrs: true,
    max_consumers: 100,
    max_msg_size: 10 * MB,
    max_msgs_per_subject: 5_000_000,
    max_msgs: 50_000_000,
    max_bytes: 5 * GB,
    max_age: 7 * DAY,
    duplicate_window: 2 * MIN,
  },

  [JetStreamKind.Command]: {
    allow_rollup_hdrs: false,
    max_consumers: 50,
    max_msg_size: 5 * MB,
    max_msgs_per_subject: 100_000,
    max_msgs: 1_000_000,
    max_bytes: 100 * MB,
    max_age: 3 * MIN,
    duplicate_window: 30 * SEC,
  },
});

const baseConsumerConfig = (
  name: string,
  kind: JetStreamKind,
): Pick<ConsumerConfig, 'name' | 'durable_name' | 'filter_subject'> => {
  return {
    durable_name: `${name}_${kind}-consumer`,
    name: `${name}_${kind}-consumer`,
    filter_subject: `${name}.${kind}.>`,
  };
};

export const consumerConfig: ConsumerConfigRecord = {
  [JetStreamKind.Event]: (name, kind) => ({
    ...baseConsumerConfig(name, kind),
    ack_wait: 10 * SEC,
    max_deliver: 3,
    max_ack_pending: 100,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    replay_policy: ReplayPolicy.Instant,

    max_batch: 100,
    mem_storage: true,
  }),

  [JetStreamKind.Command]: (name, kind) => ({
    ...baseConsumerConfig(name, kind),
    ack_wait: 60 * 5 * SEC, // 5 minutes
    max_deliver: 1,
    max_ack_pending: 100,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    replay_policy: ReplayPolicy.Instant,

    max_batch: 200,
    mem_storage: false,
  }),
};
