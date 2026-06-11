# Tech stack

- TypeScript strict, `"type": "module"`, dual CJS/ESM via tsup.
- Node >= 22 (dev runs 24.x via nvm — see `mem:suggested_commands` for the wrapper).
- NestJS peer `^10.2.0 || ^11.0.0`; NestJS peers also pinned in devDependencies (`^11.1.26`) so pnpm update reaches them.
- NATS: `@nats-io/jetstream`, `@nats-io/transport-node`, `@nats-io/nuid`. Server target: nats:2.12.6 in tests (Testcontainers).
- Tests: Vitest 4 (projects: unit + integration), `@golevelup/ts-vitest` createMock, faker, Testcontainers (per-suite NATS container).
- pnpm v11 workspace (root lib + `website/` Docusaurus docs). Overrides live in `pnpm-workspace.yaml` (NOT package.json `pnpm` field — v11 ignores it).
- Release Please v5 (release-type: node) on push to main; squash merge: PR title = commit subject, PR body = body; multi-entry changelog via BEGIN_COMMIT_OVERRIDE block in PR body.
