import type { Config } from 'jest';
import baseConfig from './jest.config';

const config: Config = {
  ...baseConfig,
  roots: ['<rootDir>/test'],
  testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
  testTimeout: 30_000,
  maxWorkers: 1, // sequential — shared NATS state
  collectCoverage: false,
  forceExit: true, // NATS client keeps internal timers alive after drain
};

export default config;
