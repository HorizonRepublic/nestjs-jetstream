
import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    rootDir: '.',  
    roots: ['<rootDir>/src'],
    testMatch: ['**/*.spec.ts', '**/*.test.ts'],
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.module.ts',
        '!src/**/*.d.ts',
        '!src/**/index.ts',
        '!src/**/*.interface.ts',
        '!src/**/*.type.ts',
    ],
    coverageDirectory: './coverage',
    coverageReporters: ['text', 'lcov', 'html'],
    moduleFileExtensions: ['js', 'json', 'ts'],
    transform: {
        '^.+\\.ts$': [
            'ts-jest',
            {
                tsconfig: {
                    esModuleInterop: true,
                    allowSyntheticDefaultImports: true,
                },
            },
        ],
    },
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
    },
    testTimeout: 10000,
    verbose: true,
};

export default config;