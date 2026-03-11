import type { Config } from 'jest';

const shared: Partial<Config> = {
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/lib/'],
  verbose: true,
};

const config: Config = {
  projects: [
    {
      ...shared,
      displayName: 'unit',
      roots: ['<rootDir>/src'],
      testMatch: ['**/*.spec.ts', '**/*.test.ts'],
      transform: {
        '^.+\\.ts$': [
          'ts-jest',
          { tsconfig: 'tsconfig.json' },
        ],
      },
      collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.module.ts',
        '!src/**/*.d.ts',
        '!src/**/index.ts',
        '!src/**/*.interface.ts',
        '!src/**/*.type.ts',
      ],
      coverageDirectory: '<rootDir>/coverage',
      testTimeout: 10_000,
    },
    {
      ...shared,
      displayName: 'integration',
      roots: ['<rootDir>/test'],
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
      transform: {
        '^.+\\.ts$': [
          'ts-jest',
          { tsconfig: 'test/tsconfig.json' },
        ],
      },
      coverageDirectory: '<rootDir>/coverage-integration',
      testTimeout: 30_000,
      forceExit: true,
    },
  ],
};

export default config;