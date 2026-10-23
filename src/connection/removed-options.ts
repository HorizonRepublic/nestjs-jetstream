type OptionsBlock = Readonly<Record<string, unknown>>;

interface RemovedOption {
  readonly key: string;
  readonly replacement: string;
}

const REMOVED_ROOT_OPTIONS: readonly RemovedOption[] = [
  { key: 'consumer', replacement: '`publisherOnly`, with the value inverted' },
  { key: 'allowDestructiveMigration', replacement: '`provisioning.allowDestructiveMigration`' },
];

const REMOVED_ORDERED_OPTIONS: readonly RemovedOption[] = [
  { key: 'deliverPolicy', replacement: '`ordered.consumer.deliver_policy`' },
  { key: 'optStartSeq', replacement: '`ordered.consumer.opt_start_seq`' },
  { key: 'optStartTime', replacement: '`ordered.consumer.opt_start_time`' },
  { key: 'replayPolicy', replacement: '`ordered.consumer.replay_policy`' },
];

const isBlock = (value: unknown): value is OptionsBlock =>
  typeof value === 'object' && value !== null;

const findRemoved = (block: OptionsBlock, path: string): string[] => {
  const found = REMOVED_ROOT_OPTIONS.filter(({ key }) => Object.hasOwn(block, key)).map(
    ({ key, replacement }) => `\`${path}${key}\` moved to ${replacement}`,
  );

  const ordered = block.ordered;

  if (isBlock(ordered)) {
    for (const { key, replacement } of REMOVED_ORDERED_OPTIONS) {
      if (Object.hasOwn(ordered, key)) {
        found.push(`\`${path}ordered.${key}\` moved to ${replacement}`);
      }
    }
  }

  return found;
};

/**
 * Fails fast on option names that v3 removed.
 *
 * TypeScript rejects them at compile time, but a JavaScript caller or a loosely
 * typed `useFactory` would otherwise boot with them silently ignored, and
 * ignoring `consumer: false` turns a publisher-only gateway into a consumer.
 *
 * @param options Raw root module options, checked before any typing is trusted.
 */
export const assertNoRemovedOptions = (options: object): void => {
  const root = options as OptionsBlock;
  const found = findRemoved(root, '');
  const connections = root.connections;

  if (isBlock(connections)) {
    for (const [name, connection] of Object.entries(connections)) {
      if (isBlock(connection)) {
        found.push(...findRemoved(connection, `connections.${name}.`));
      }
    }
  }

  if (found.length > 0) {
    throw new Error(
      `JetstreamModule received options removed in v3:\n- ${found.join('\n- ')}\n` +
        'See the v2.13 → v3.0 section of the migration guide.',
    );
  }
};
