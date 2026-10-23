# Contributing to @horizon-republic/nestjs-jetstream

Contributions are welcome. This file covers what you need to open a pull
request; the [contributing guide](https://nestjs-jetstream.horizon-republic.dev/docs/development/contributing)
and the [testing guide](https://nestjs-jetstream.horizon-republic.dev/docs/development/testing)
go into more detail.

## Prerequisites

- Node.js >= 22
- pnpm >= 12.15
- Docker: integration tests start NATS through [Testcontainers](https://testcontainers.com/)

## Setup

```bash
git clone https://github.com/<your-username>/nestjs-jetstream.git
cd nestjs-jetstream
pnpm install
git checkout -b <type>/<short-description>
```

## Before you open a pull request

CI runs these, and each one fails the build on its own:

```bash
pnpm lint          # oxlint, type-aware
pnpm lint:md       # markdownlint
pnpm format:check  # oxfmt over source, tests, examples and docs
pnpm typecheck
pnpm test:cov      # unit and integration tests
```

`pnpm format` and `pnpm lint:fix` repair most of what the first three report.
To run an example against a local NATS, start one with `docker compose up -d`
and run `pnpm dev:example`.

## Code

- TypeScript, strict. No `as any`.
- Exported types live apart from implementations: shared contracts in
  `src/interfaces/`, module-local ones in a `<module>.types.ts` file.
- New behaviour comes with tests: `sut` for the system under test,
  `createMock<T>()` for mocks, Given-When-Then comments.
- Public APIs carry JSDoc. Docs under `website/docs/` change with the code
  they describe.

## Commits and pull requests

Commits and PR titles follow
[Conventional Commits](https://www.conventionalcommits.org/):
`feat(client): ...`, `fix(routing): ...`, `docs: ...`.
[Release Please](https://github.com/googleapis/release-please) turns the PR
title into the changelog entry and the version bump, so write it for a reader
of the changelog. A PR that carries several changes can list them between
`BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE` in its description, one
conventional line each.

Keep a pull request to one concern. Every PR is reviewed before it is merged.

## Reporting bugs and security issues

Bugs and feature requests go to
[GitHub issues](https://github.com/HorizonRepublic/nestjs-jetstream/issues).
Security issues do not: follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE.md).
