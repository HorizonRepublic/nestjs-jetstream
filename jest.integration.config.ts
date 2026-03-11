import type { Config } from 'jest';
import baseConfig from './jest.config';

const config: Config = {
  ...baseConfig,
  roots: ['<rootDir>/test'],
  testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
  testTimeout: 30_000,
  maxWorkers: 1, // sequential — shared NATS state
  collectCoverage: true,
  coverageDirectory: '<rootDir>/coverage-integration',
  forceExit: true, // NATS client keeps internal timers alive after drain
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          rootDir: '.',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          emitDecoratorMetadata: true,
          experimentalDecorators: true,
        },
      },
    ],
  },
};

export default config;
