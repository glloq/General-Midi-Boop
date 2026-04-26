# Contributing

Full guide: [`CONTRIBUTING.md`](https://github.com/glloq/General-Midi-Boop/blob/main/CONTRIBUTING.md). This page is the wiki summary.

## Getting Set Up

```bash
git clone https://github.com/glloq/General-Midi-Boop.git
cd General-Midi-Boop
npm install
npm run dev    # backend with hot reload
```

For the frontend dev server only:

```bash
npm run dev:frontend
```

## Branching

- Open a feature branch off `main`.
- Keep changes focused — one feature or fix per PR.
- Follow the commit-message style visible in `git log` (imperative mood, scope-prefixed where useful).

## Code Style

- **Linter**: ESLint, configured in [`.eslintrc.json`](https://github.com/glloq/General-Midi-Boop/blob/main/.eslintrc.json). Run `npm run lint` and `npm run lint:fix`.
- **Formatter**: Prettier, configured in [`.prettierrc`](https://github.com/glloq/General-Midi-Boop/blob/main/.prettierrc). Run `npm run format`.
- **Type-checking**: TypeScript ambient types in [`src/types/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/types). Run `npm run typecheck`.
- **Pre-commit hook**: Husky + lint-staged auto-lints staged files (`.husky/pre-commit`). Don't bypass with `--no-verify`.

## Tests

| Command | What it runs |
|---|---|
| `npm test` | Backend unit + integration tests (Jest, ESM) |
| `npm run test:coverage` | Same with coverage report |
| `npm run test:frontend` | Frontend tests (Vitest) |
| `npm run test:frontend:watch` | Frontend tests in watch mode |
| `npm run bench` | Performance benchmarks under [`tests/performance/`](https://github.com/glloq/General-Midi-Boop/tree/main/tests/performance) |

Tests live under [`tests/`](https://github.com/glloq/General-Midi-Boop/tree/main/tests) (`unit`, `integration`, `performance`, `frontend`).

## Architecture Decision Records

Significant design choices are tracked as ADRs in [`docs/adr/`](https://github.com/glloq/General-Midi-Boop/tree/main/docs/adr). Read existing ADRs before proposing structural changes; add a new ADR when you make one.

## Documentation

- Update [`docs/`](https://github.com/glloq/General-Midi-Boop/tree/main/docs) for deep technical changes.
- Update the relevant wiki page in [`wiki/`](https://github.com/glloq/General-Midi-Boop/tree/main/wiki) for user-facing changes — it auto-syncs to the GitHub Wiki on merge to `main`.
- Add a note to [`CHANGELOG.md`](https://github.com/glloq/General-Midi-Boop/blob/main/CHANGELOG.md) for anything user-visible.

## Adding a Command

1. Create or edit a module under [`src/api/commands/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/api/commands).
2. Export `{ commands: { my_command: handler } }` — the [`CommandRegistry`](https://github.com/glloq/General-Midi-Boop/blob/main/src/api/CommandRegistry.js) auto-discovers it.
3. Cover it with a unit test.
4. Document parameters and return shape in [`docs/API.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/API.md).
5. Mention it in [[API-Reference]] if the count or example list changes.

## Adding a Lighting Driver

1. Subclass [`BaseLightingDriver`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/BaseLightingDriver.js).
2. Register it in the lighting manager's driver map.
3. Add fixture profiles to [`DmxFixtureProfiles.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/DmxFixtureProfiles.js) if the driver speaks DMX.
4. Update [[Lighting]] with the new driver row.

## Reporting Issues

Use [GitHub Issues](https://github.com/glloq/General-Midi-Boop/issues). Helpful information:

- OS, Node version, hardware (Pi 3B+ / 4 / 5)
- Output of `npm start` with `GMBOOP_LOG_LEVEL=debug`
- Steps to reproduce, expected vs. actual behaviour
- Relevant section of `CHANGELOG.md` if upgrading
