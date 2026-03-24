# Contributing to Ma-est-tro

## Getting Started

```bash
git clone https://github.com/glloq/Ma-est-tro.git
cd Ma-est-tro
npm install
cp .env.example .env  # Configure local settings
npm run dev            # Start with hot-reload
```

## Development Workflow

1. Create a feature branch from `main`
2. Make your changes
3. Ensure lint passes: `npm run lint`
4. Ensure tests pass: `npm test`
5. Commit with a descriptive message (see below)
6. Push and open a Pull Request

## Code Style

- **Linter**: ESLint (`npm run lint` / `npm run lint:fix`)
- **Formatter**: Prettier (`npm run format`)
- **Pre-commit hooks**: Husky + lint-staged run automatically on `git commit`
- **Language**: Comments and code in English (exception: French OK in user-facing docs)

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add BLE device pairing
fix: prevent crash on missing MIDI device
test: add ServiceContainer unit tests
docs: update API reference
refactor: extract dynamic update helper
chore: update dependencies
```

## Testing

```bash
npm test                # Run all tests
npm run test:coverage   # Run with coverage report
```

- Tests use Jest with ESM support (`--experimental-vm-modules`)
- Import from `@jest/globals`: `import { jest, describe, test, expect } from '@jest/globals'`
- Use in-memory SQLite for database tests
- Mock the logger: `{ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }`

## Database Migrations

- Add new migrations in `migrations/` with numbered prefix: `023_description.sql`
- Add corresponding down migration in `migrations/down/` with matching filename
- Migrations run automatically on startup
- Rollback: `npm run migrate:rollback` (rolls back 1 step)

## Project Structure

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full architecture overview.

## API

See [docs/API.md](./docs/API.md) for the complete API reference (146 commands).
