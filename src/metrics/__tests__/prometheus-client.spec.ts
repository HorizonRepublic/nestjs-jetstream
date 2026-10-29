import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigErrorReason } from '../../errors';
import type { MetricsRegistry } from '../metrics.config';
import type {
  LoadedPrometheusClient,
  PrometheusPackage,
  PrometheusRuntime,
} from '../metrics.types';
import {
  createPrometheusLoader,
  loadPrometheusPackage,
  resolvePrometheusClient,
  selectPrometheusClient,
} from '../prometheus-client';

class IoRegistry implements MetricsRegistry {
  public setDefaultLabels(): void {}
  public registerMetric(): void {}
}

class LegacyRegistry implements MetricsRegistry {
  public setDefaultLabels(): void {}
  public registerMetric(): void {}
}

const runtimeWith = (Registry: new () => MetricsRegistry): PrometheusRuntime => ({
  Counter: vi.fn() as unknown as PrometheusRuntime['Counter'],
  Gauge: vi.fn() as unknown as PrometheusRuntime['Gauge'],
  Histogram: vi.fn() as unknown as PrometheusRuntime['Histogram'],
  Registry,
  register: new Registry(),
});

const io: LoadedPrometheusClient = {
  name: '@prometheus-io/client',
  runtime: runtimeWith(IoRegistry),
};
const legacy: LoadedPrometheusClient = {
  name: 'prom-client',
  runtime: runtimeWith(LegacyRegistry),
};

describe(selectPrometheusClient, () => {
  afterEach(vi.resetAllMocks);

  it('should pick the only installed package when no registry is given', () => {
    // When
    const sut = selectPrometheusClient([legacy], undefined);

    // Then
    expect(sut).toBe(legacy);
  });

  it('should pick the package the given registry belongs to', () => {
    // When
    const sut = selectPrometheusClient([io, legacy], new LegacyRegistry());

    // Then
    expect(sut).toBe(legacy);
  });

  it('should accept a registry from another copy when only one package is installed', () => {
    // When
    const sut = selectPrometheusClient([io], new LegacyRegistry());

    // Then
    expect(sut).toBe(io);
  });

  it('should fail when no package is installed', () => {
    // When / Then
    expect(() => selectPrometheusClient([], undefined)).toThrow(
      expect.objectContaining({
        name: 'JetstreamConfigError',
        reason: ConfigErrorReason.PrometheusClientMissing,
        message: expect.stringMatching(/pnpm add @prometheus-io\/client/),
      }),
    );
  });

  it('should refuse to guess between two installed packages without a registry', () => {
    // When / Then
    expect(() => selectPrometheusClient([io, legacy], undefined)).toThrow(
      expect.objectContaining({
        name: 'JetstreamConfigError',
        reason: ConfigErrorReason.AmbiguousPrometheusClient,
        message: expect.stringMatching(/Pass metrics.register/),
      }),
    );
  });

  it('should fail on a registry neither installed package owns', () => {
    // Given a registry of some third origin
    const foreign = createMock<MetricsRegistry>();

    // When / Then
    expect(() => selectPrometheusClient([io, legacy], foreign)).toThrow(
      expect.objectContaining({
        name: 'JetstreamConfigError',
        reason: ConfigErrorReason.ForeignRegistry,
        message: expect.stringMatching(/not a Registry of the installed/),
      }),
    );
  });
});

describe(resolvePrometheusClient, () => {
  afterEach(vi.resetAllMocks);

  it('should skip packages that are not installed', async () => {
    // Given only prom-client loads
    const load = vi.fn(async (name: PrometheusPackage) =>
      name === 'prom-client' ? legacy.runtime : null,
    );

    // When
    const sut = await resolvePrometheusClient(undefined, load);

    // Then
    expect(sut).toEqual(legacy);
    expect(load).toHaveBeenCalledWith('@prometheus-io/client');
  });
});

describe(loadPrometheusPackage, () => {
  it.each(['@prometheus-io/client', 'prom-client'] as const)('should load %s', async (name) => {
    // When
    const sut = await loadPrometheusPackage(name);

    // Then
    expect(sut?.register).toBeInstanceOf(sut?.Registry ?? Object);
    expect(typeof sut?.Counter).toBe('function');
  });
});

describe(createPrometheusLoader, () => {
  afterEach(vi.resetAllMocks);

  it('should report a package that is not installed as absent', async () => {
    // Given
    const missing = Object.assign(new Error("Cannot find package 'prom-client'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const sut = createPrometheusLoader(vi.fn().mockRejectedValue(missing));

    // When / Then
    await expect(sut('prom-client')).resolves.toBeNull();
  });

  it('should rethrow a missing dependency of an installed package', async () => {
    // Given the package resolves but one of its own imports does not
    const missingDependency = Object.assign(
      new Error(
        "Cannot find module 'tdigest'\nRequire stack:\n- /app/node_modules/prom-client/lib/summary.js",
      ),
      { code: 'MODULE_NOT_FOUND' },
    );
    const sut = createPrometheusLoader(vi.fn().mockRejectedValue(missingDependency));

    // When / Then
    await expect(sut('prom-client')).rejects.toThrow(/tdigest/);
  });

  it('should rethrow any other failure to load an installed package', async () => {
    // Given
    const sut = createPrometheusLoader(
      vi.fn().mockRejectedValue(new Error('prom-client failed to initialise')),
    );

    // When / Then
    await expect(sut('prom-client')).rejects.toThrow(/failed to initialise/);
  });
});
