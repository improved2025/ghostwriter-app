# Codex Agent Instructions (Authored / ghostwriter-app)

## Goal
Stabilize and solidify repo structure and reliability without breaking behavior.

## Non-negotiables
- No large refactors in one step. Make small, reviewable commits.
- Do not guess. If framework/build tooling is unclear, inspect files first.
- Keep public behavior stable: routes, exported functions, and UI flows should remain consistent unless explicitly changed.
- Never put secrets in code or commit them. Only reference env vars.
- Keep OpenAI/Supabase/Stripe usage on the server unless explicitly designed otherwise.

## Required first steps (always do these before editing)
1) Print the repo tree (exclude node_modules, .next, dist, build).
2) Read: package.json, README, tsconfig/jsconfig, next.config.*, vite.config.*, eslint config, and any /app or /src structure.
3) Identify framework and runtime boundaries (client vs server).

## Validation loop (must run after each change)
- If package-lock.json exists: use npm. If pnpm-lock.yaml exists: use pnpm. If yarn.lock exists: use yarn.
- Run the strongest available checks from package.json scripts:
  - lint
  - typecheck
  - test
  - build
- If scripts are missing, create them only after identifying the framework.

## Safety rails for dependencies
- OpenAI SDK (v4+): keep API calls server-side. Never expose API keys to the client bundle.
- Supabase: use anon key only in client (if needed). Service role key must be server-only.
- Stripe: secret key server-only; webhooks must verify signatures; never call Stripe secret APIs from client.

## Output format when reporting
- For each change: list file paths changed, exact reason, and commands run with results.
- Call out any behavior changes explicitly.
