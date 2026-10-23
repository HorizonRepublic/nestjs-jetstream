import { createHash } from 'node:crypto';

import type { StoredMsg } from '@nats-io/jetstream';
import { headers } from '@nats-io/transport-node';

import { ScheduleOrigin } from '../interfaces';
import type { ScheduleInfo, ScheduleSpec } from '../interfaces';
import { JetstreamHeader } from '../jetstream.constants';
import { isCronSchedule, resolveTickTtlSeconds, toNatsSpecification } from './schedule-spec';
import type { HolderMessage, StoredHolder } from './schedule.types';

const SCHEDULE_HEADER = 'Nats-Schedule';
const SCHEDULE_TTL_HEADER = 'Nats-Schedule-TTL';
const SCHEDULE_TIMEZONE_HEADER = 'Nats-Schedule-Time-Zone';

const ORIGINS: readonly ScheduleOrigin[] = [ScheduleOrigin.Declared, ScheduleOrigin.Dynamic];

const hashField = (hash: ReturnType<typeof createHash>, value: string | Uint8Array): void => {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;

  // Length-prefixed, so a value cannot shift from one field into the next.
  hash.update(`${bytes.length}:`);
  hash.update(bytes);
};

/** A stable fingerprint of what a schedule was declared as. */
export const definitionHash = (
  pattern: string,
  specification: string,
  timezone: string | undefined,
  ttlSeconds: number | undefined,
  payload: Uint8Array,
): string => {
  const hash = createHash('sha256');

  hashField(hash, pattern);
  hashField(hash, specification);
  hashField(hash, timezone ?? '');
  hashField(hash, ttlSeconds === undefined ? '' : String(ttlSeconds));
  hashField(hash, payload);

  return hash.digest('hex');
};

/**
 * The holder message for a schedule. It carries no message id and no trace
 * context: the server copies holder headers into every tick it fires.
 */
export const buildHolder = (
  subject: string,
  target: string,
  pattern: string,
  spec: ScheduleSpec,
  payload: Uint8Array,
  now: Date,
): HolderMessage => {
  const specification = toNatsSpecification(spec);
  const ttlSeconds = resolveTickTtlSeconds(spec, now);
  const timezone = isCronSchedule(spec) ? spec.timezone : undefined;
  // The declared TTL, not the computed one: a cron's computed default moves with the
  // boot date (a monthly cron gets 28 days in January, 30 in March).
  const hash = definitionHash(pattern, specification, timezone, spec.ttlSeconds, payload);
  const hdrs = headers();

  hdrs.set(JetstreamHeader.ScheduleHash, hash);
  hdrs.set(JetstreamHeader.SchedulePattern, pattern);

  return {
    subject,
    payload,
    hash,
    options: {
      headers: hdrs,
      schedule: {
        specification,
        target,
        ...(ttlSeconds === undefined ? {} : { ttl: `${ttlSeconds}s` }),
        ...(timezone === undefined ? {} : { timezone }),
      },
    },
  };
};

const parseTtlSeconds = (value: string | undefined): number | undefined => {
  const match = value === undefined ? null : /^(\d+)s$/.exec(value);

  return match ? Number(match[1]) : undefined;
};

/**
 * Read a stored holder back, or `null` for a message that is not one of ours:
 * outside the `decl.` and `dyn.` namespaces, or written without our headers.
 */
export const readHolder = (msg: StoredMsg, holderPrefix: string): StoredHolder | null => {
  const rest = msg.subject.startsWith(holderPrefix) ? msg.subject.slice(holderPrefix.length) : '';
  const origin = ORIGINS.find((candidate) => rest.startsWith(`${candidate}.`));
  const hash = msg.header.get(JetstreamHeader.ScheduleHash);
  const pattern = msg.header.get(JetstreamHeader.SchedulePattern);

  if (origin === undefined || !hash || !pattern) return null;

  const timezone = msg.header.get(SCHEDULE_TIMEZONE_HEADER) || undefined;
  const ttlSeconds = parseTtlSeconds(msg.header.get(SCHEDULE_TTL_HEADER) || undefined);
  const info: ScheduleInfo = {
    id: rest.slice(origin.length + 1),
    origin,
    pattern,
    specification: msg.header.get(SCHEDULE_HEADER),
    ...(timezone === undefined ? {} : { timezone }),
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
  };

  return { subject: msg.subject, seq: msg.seq, hash, writtenAt: msg.time, info };
};
