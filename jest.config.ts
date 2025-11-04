
import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    rootDir: './src',  // rootDir вказує на src
    testMatch: ['**/__tests__/**/*.ts', '**/*.spec.ts', '**/*.test.ts'],  // шукаємо відносно src
    collectCoverageFrom: [
        '**/*.ts',  // Змінюємо з 'src/**/*.ts' на '**/*.ts'
        '!**/*.module.ts',
        '!**/*.d.ts',
        '!**/index.ts',
        '!**/*.interface.ts',
        '!**/*.type.ts',
    ],
    coverageDirectory: '../coverage',  // Виносимо coverage на рівень вище
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
        '^@/(.*)$': '<rootDir>/$1', 
    },
    testTimeout: 10000,
    testPathIgnorePatterns: ['/node_modules/', '/dist/', '/lib/'],
    verbose: true,
};

export default config;