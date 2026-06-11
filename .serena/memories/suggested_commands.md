# Suggested commands

Node tooling often fails bare in this shell (nvm not loaded). Wrap:
`bash -c 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && <cmd>'`

- `pnpm test` — unit + integration (integration needs Docker; NATS via Testcontainers, no manual setup).
- `npx vitest run --project unit [path]` / `--project integration [path]` — targeted runs; `-t "substring"` filters tests.
- `pnpm test:cov` — coverage (lcov in coverage/).
- `npx tsc --noEmit` — typecheck.
- `pnpm lint` / `pnpm lint:fix` — eslint (also `npx eslint --fix <files>` for targeted).
- `pnpm build` — tsup.
- `pnpm docs:generate` — TypeDoc (NEVER `pnpm docs` — collides with npm builtin).
- `cd website && pnpm schema` — regenerate structured-data Root.js after touching doc frontmatter.
- `cd website && pnpm build` — docs build (verifies webpack chain).
- GitHub: `gh` CLI (PRs, runs, dependabot alerts).
