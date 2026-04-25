import { createRequire } from 'node:module';

import { defineConfig } from 'tsup';

// `createRequire` keeps package.json out of the compiled bundle's imports
// while working under both CJS and ESM tsup execution (native JSON import
// assertions are not yet stable across all supported Node versions).
const pkg = createRequire(import.meta.url)('./package.json') as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  tsconfig: 'tsconfig.build.json',
  sourcemap: false,
  clean: true,
  target: 'es2024',
  splitting: false,
  define: {
    __PACKAGE_VERSION__: JSON.stringify(pkg.version),
  },
  external: [
    '@nestjs/common',
    '@nestjs/core',
    '@nestjs/microservices',
    'nats',
    'reflect-metadata',
    'rxjs',
  ],
});