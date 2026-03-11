import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  tsconfig: 'tsconfig.build.json',
  sourcemap: true,
  clean: true,
  target: 'es2024',
  splitting: false,
  external: [
    '@nestjs/common',
    '@nestjs/core',
    '@nestjs/microservices',
    'nats',
    'reflect-metadata',
    'rxjs',
  ],
});