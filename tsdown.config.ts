import { createRequire } from 'node:module';

import { defineConfig } from 'tsdown';

// `createRequire` keeps package.json out of the compiled bundle's imports
// while working under both CJS and ESM execution (native JSON import
// assertions are not yet stable across all supported Node versions).
const pkg = createRequire(import.meta.url)('./package.json') as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  // Declarations come from Oxc, driven by `isolatedDeclarations` in
  // tsconfig.build.json - no TypeScript compiler API involved.
  dts: true,
  tsconfig: 'tsconfig.build.json',
  sourcemap: false,
  clean: true,
  target: 'es2024',
  platform: 'node',
  // Keep the published filenames as `.js` / `.d.ts` for ESM and `.cjs` /
  // `.d.cts` for CJS, matching the `exports` map in package.json.
  fixedExtension: false,
  define: {
    __PACKAGE_VERSION__: JSON.stringify(pkg.version),
  },
  deps: {
    neverBundle: [
      '@nestjs/common',
      '@nestjs/core',
      '@nestjs/microservices',
      'nats',
      'reflect-metadata',
      'rxjs',
    ],
  },
});
