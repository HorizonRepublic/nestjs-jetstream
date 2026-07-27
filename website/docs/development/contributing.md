---
sidebar_position: 2
title: Contributing
schema:
  type: Article
  headline: "Contributing"
  description: "How to contribute to the project."
  datePublished: "2026-03-21"
  dateModified: "2026-07-27"
---

# Contributing

We welcome contributions from the community. The full contribution guidelines live in the [`CONTRIBUTING.md`](https://github.com/HorizonRepublic/nestjs-jetstream/blob/main/CONTRIBUTING.md) file at the repository root.

## Quick Start

1. **Fork** the repository on GitHub
2. **Clone** your fork and install dependencies:

   ```bash
   git clone https://github.com/your-username/nestjs-jetstream.git
   cd nestjs-jetstream
   pnpm install
   ```

3. **Create a branch** for your change:

   ```bash
   git checkout -b feat/your-feature-name
   ```

4. **Make your changes**, write tests, and verify everything passes:

   ```bash
   pnpm lint
   pnpm test
   ```

5. **Push** and open a Pull Request

## Prerequisites

- Node.js >= 22.0.0
- pnpm >= 10
- Docker (integration tests use [Testcontainers](https://testcontainers.com/) to start NATS automatically)

## Development Commands

| Command             | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `pnpm build`        | Build the library with tsdown, dual CJS/ESM                        |
| `pnpm build:watch`  | Build in watch mode                                                |
| `pnpm typecheck`    | Type-check against `tsconfig.build.json`                           |
| `pnpm lint`         | Lint with oxlint, type-aware rules included                        |
| `pnpm lint:fix`     | Lint and apply fixes                                               |
| `pnpm lint:md`      | Lint markdown structure with markdownlint                          |
| `pnpm format`       | Format source and docs with oxfmt                                  |
| `pnpm format:check` | Check formatting without writing                                   |
| `pnpm test`         | Run unit and integration tests in parallel                         |
| `pnpm test:watch`   | Run tests in watch mode                                            |
| `pnpm test:cov`     | Run tests with coverage                                            |
| `pnpm bench`        | Run the benchmark harness                                          |
| `pnpm docs:api`     | Regenerate the TypeDoc API reference                               |
| `pnpm docs:dev`     | Regenerate the API reference, then start the Docusaurus dev server |
| `pnpm docs:build`   | Regenerate the API reference, then build the site                  |
| `pnpm docs:serve`   | Serve the built site locally                                       |

See [Testing](/docs/development/testing) for detailed test conventions and setup.

:::note Port collision between `docs:dev` and `dev:example`
Docusaurus' dev server and the example apps both default to port 3000. If you run `pnpm docs:dev` and `pnpm dev:example` in the same pass, the second one fails with `EADDRINUSE`. Launch Docusaurus with `PORT=3100 pnpm docs:dev` (or edit the example's bootstrap port) when you need both running side-by-side.
:::

## Commit Message Format

The project uses [Conventional Commits](https://www.conventionalcommits.org/) with [Release Please](https://github.com/googleapis/release-please) for automated releases. Your commit messages determine how the changelog and version bumps are generated.

| Prefix      | Purpose               | Version Bump |
| ----------- | --------------------- | ------------ |
| `feat:`     | New feature           | Minor        |
| `fix:`      | Bug fix               | Patch        |
| `docs:`     | Documentation         | None         |
| `refactor:` | Code refactoring      | None         |
| `test:`     | Adding/updating tests | None         |
| `chore:`    | Maintenance           | None         |

**Examples:**

```text
feat: add support for custom stream configuration
fix(strategy): remove private logger that shadows Server base class
docs: update module configuration examples
```

:::tip
Use a scope in parentheses (e.g., `feat(client):`, `fix(strategy):`) to show the area of the codebase affected. This shows up in the generated changelog.
:::

## Pull Request Guidelines

- Ensure the build passes (`pnpm build`)
- All linting checks must pass (`pnpm lint`)
- All existing tests must pass, and new code should include tests
- Use clear, descriptive PR titles: they become changelog entries via Release Please
- Keep PRs focused on a single concern

## Coding Standards

- TypeScript for all code
- JSDoc comments on all public APIs
- Follow existing code style (enforced by oxlint and oxfmt)
- See [Testing](/docs/development/testing) for test conventions (`sut` naming, `createMock<T>()`, Given-When-Then, etc.)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](https://github.com/HorizonRepublic/nestjs-jetstream/blob/main/LICENSE).
