# Conventions

Code:
- Comments: DEFAULT NONE. One-line JSDoc max on exported symbols when names can't carry it. Never multi-line rationale comments; knowledge belongs in tests (descriptive names). User escalates hard on violations.
- Named types only — no inline unions/object literals in signatures or fields. Enums over string unions.
- Arrow functions (`prefer-arrow`); exhaustive switches end with `default: { const _exhaustive: never = x; throw ... }` + `/* v8 ignore next 5 */`.
- eslint `padding-line-between-statements`: blank line before return/expect/post-block assignments. sonarjs cognitive-complexity 15 — extract private methods early.
- NATS snake_case fields need `/* eslint-disable @typescript-eslint/naming-convention */` (prefer typing via library types to avoid it).
- No `as any`; no non-null `!` in src (throwing getters instead).
- Max decomposition: one concern per private method; public methods read as orchestration (SOLID/KISS/DRY — explicit user mandate).

Tests:
- `sut`; `createMock<T>()`; faker; Given-When-Then ONE-LINE markers; explicit vitest imports; `afterEach(vi.resetAllMocks)`; `await expect(...).rejects` (no auto-await).
- TDD mandatory: RED first, watch it fail, then implement. Integration-first for infrastructure; unit for unreachable error paths.
- Hung-handler fixtures must be resolved at test end (shared ack-extension timer pool leaks across tests otherwise).

Commits/PRs:
- Conventional commits; NEVER any AI attribution (no Co-Authored-By, no "Generated with"). Human-style bodies.
- Internal docs (`docs/superpowers/`, `.claude/plans/`, `CLAUDE.md`, `.serena/`) are gitignored — never commit, never reference externally.

Docs (website/docs): schema frontmatter required; bump dateModified (today) on edit; new pages MUST be added to sidebars.ts; regenerate via `cd website && pnpm schema`.
