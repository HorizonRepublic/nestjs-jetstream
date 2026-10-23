import type { MetricsRegistry } from './metrics.config';
import type {
  LoadedPrometheusClient,
  PrometheusImporter,
  PrometheusLoader,
  PrometheusPackage,
  PrometheusRuntime,
} from './metrics.types';

/** Preference order when nothing else decides between installed packages. */
const PACKAGES: readonly PrometheusPackage[] = ['@prometheus-io/client', 'prom-client'];

const NOT_FOUND_CODES = new Set(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']);

const INSTALL_MESSAGE =
  'Metrics need a Prometheus client. Install one with: pnpm add @prometheus-io/client ' +
  '(prom-client, its previous name, works too).';

const AMBIGUOUS_MESSAGE =
  'Both @prometheus-io/client and prom-client are installed, and their global registries are ' +
  'different objects. Pass metrics.register with the registry your /metrics endpoint serves.';

const FOREIGN_REGISTRY_MESSAGE =
  'metrics.register is not a Registry of the installed @prometheus-io/client or prom-client, ' +
  'so it is unclear which package should build the metrics.';

const isMissingPackage = (error: unknown, name: PrometheusPackage): boolean =>
  error instanceof Error &&
  NOT_FOUND_CODES.has((error as NodeJS.ErrnoException).code ?? '') &&
  // Node quotes the specifier it failed to resolve. The package name also
  // appears unquoted in the require stack when one of its own dependencies is
  // missing, which must not read as "not installed".
  error.message.includes(`'${name}'`);

/**
 * Erase the package's own Registry type once the compiler has checked every
 * constructor against it. Safe because selectPrometheusClient only ever pairs
 * a registry with the package it belongs to.
 */
const eraseRegistryType = <R extends MetricsRegistry>(
  runtime: PrometheusRuntime<R>,
): PrometheusRuntime => runtime as unknown as PrometheusRuntime;

const importRuntime: PrometheusImporter = async (name) => {
  if (name === '@prometheus-io/client') {
    const { Counter, Gauge, Histogram, Registry, register } = await import('@prometheus-io/client');

    return eraseRegistryType({ Counter, Gauge, Histogram, Registry, register });
  }

  const { Counter, Gauge, Histogram, Registry, register } = await import('prom-client');

  return eraseRegistryType({ Counter, Gauge, Histogram, Registry, register });
};

/** Treat a package that cannot be found as absent; any other import failure is real. */
export const createPrometheusLoader =
  (importer: PrometheusImporter): PrometheusLoader =>
  async (name) => {
    try {
      return await importer(name);
    } catch (error) {
      if (isMissingPackage(error, name)) return null;

      throw error;
    }
  };

/** Load a package through `import()` so it stays an optional peer dependency. */
export const loadPrometheusPackage: PrometheusLoader = createPrometheusLoader(importRuntime);

/**
 * Pick the package that builds the metrics.
 *
 * A given registry decides: metrics must come from the package that registry
 * belongs to. Without one, the only installed package wins, and two installed
 * packages are an error, since guessing would put the metrics in a registry
 * nobody scrapes.
 *
 * @throws Error when no package is installed, or when the choice is ambiguous.
 */
export const selectPrometheusClient = (
  installed: readonly LoadedPrometheusClient[],
  register: MetricsRegistry | undefined,
): LoadedPrometheusClient => {
  const [first] = installed;

  if (first === undefined) throw new Error(INSTALL_MESSAGE);

  if (register !== undefined) {
    const owner = installed.find((client) => register instanceof client.runtime.Registry);

    if (owner) return owner;
    if (installed.length === 1) return first;

    throw new Error(FOREIGN_REGISTRY_MESSAGE);
  }

  if (installed.length > 1) throw new Error(AMBIGUOUS_MESSAGE);

  return first;
};

/** Load every installed package and select the one that builds the metrics. */
export const resolvePrometheusClient = async (
  register: MetricsRegistry | undefined,
  load: PrometheusLoader = loadPrometheusPackage,
): Promise<LoadedPrometheusClient> => {
  const runtimes = await Promise.all(PACKAGES.map(async (name) => load(name)));
  const installed = PACKAGES.flatMap((name, i): LoadedPrometheusClient[] => {
    const runtime = runtimes[i];

    return runtime ? [{ name, runtime }] : [];
  });

  return selectPrometheusClient(installed, register);
};
