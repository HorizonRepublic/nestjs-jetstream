# Task completion checklist

Run all (nvm-wrapped, see `mem:suggested_commands`):
1. `npx tsc --noEmit`
2. `pnpm lint` (zero warnings tolerated)
3. `pnpm test` (full; integration requires Docker). Known flake: metrics suite under full-suite load — rerun once before investigating.
4. If website/docs touched: `cd website && pnpm schema` and `pnpm build`.
5. Commit per logical change, conventional message, no AI attribution.
