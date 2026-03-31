import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.module.ts',
        'src/**/*.d.ts',
        'src/**/index.ts',
        'src/**/*.interface.ts',
        'src/**/*.type.ts',
      ],
      reportsDirectory: './coverage',
      reporter: ['text', 'lcov', 'html'],
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
          setupFiles: ['test/setup-unit.ts'],
          testTimeout: 10_000,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/**/*.spec.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: true,
        },
      },
    ],
  },
});