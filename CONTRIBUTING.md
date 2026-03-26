# Contributing to Ma-est-tro

## Getting Started

### Prerequisites

- Node.js >= 20.0.0
- npm

### Setup

```bash
git clone https://github.com/glloq/Ma-est-tro.git
cd Ma-est-tro
npm install
cp .env.example .env  # Configure local settings
npm run dev            # Start with hot-reload
```

### Docker Development

```bash
docker-compose up -d
```

See [docs/INSTALLATION.md](./docs/INSTALLATION.md) for full setup instructions including Bluetooth and Network MIDI configuration.

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
- **Language**: Comments and code in English

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
npm test                # Run backend tests (Jest)
npm run test:coverage   # Run with coverage report
npm run test:frontend   # Run frontend tests (Vitest)
```

- Backend tests use Jest with ESM support (`--experimental-vm-modules`)
- Import from `@jest/globals`: `import { jest, describe, test, expect } from '@jest/globals'`
- Use in-memory SQLite for database tests
- Mock the logger: `{ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }`
- Frontend tests use Vitest

## Environment Variables

Configuration can be overridden via environment variables (highest priority) or a `.env` file. See `.env.example` for all supported variables.

Key variables:
- `MAESTRO_SERVER_PORT` - HTTP/WebSocket port (default: 8080)
- `MAESTRO_DATABASE_PATH` - SQLite file path
- `MAESTRO_LOG_LEVEL` - Log level (debug, info, warn, error)
- `MAESTRO_BLE_ENABLED` - Enable Bluetooth LE MIDI
- `MAESTRO_SERIAL_ENABLED` - Enable Serial/GPIO MIDI
- `MAESTRO_API_TOKEN` - Optional authentication token

## Database Migrations

- Add new migrations in `migrations/` with numbered prefix: `030_description.sql`
- Add corresponding down migration in `migrations/down/` with matching filename
- Migrations run automatically on startup (29 migrations currently)
- Rollback: `npm run migrate:rollback` (rolls back 1 step)

## Project Structure

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full architecture overview.

## API

See [docs/API.md](./docs/API.md) for the complete API reference (146 commands).

## Known Issues & Improvement Areas

The following areas have been identified through code audits as needing attention. Contributions in these areas are especially welcome.

### Security (High Priority)

- **XSS in InstrumentManagementPage**: `displayName`, `instrument.id`, and error messages are injected into `innerHTML` without `escapeHtml()`. All dynamic content in HTML should be escaped.
- **MIDI parser infinite loops**: `readVariableLength` and `parseTrack` in CustomMidiParser can loop forever on corrupted files. Add `bytesRead` guards.
- **MidiMessage property injection**: `MidiMessage.parseObject()` lacks a property whitelist.

### MIDI Core (High Priority)

- **Note 0 bug**: The `||` operator treats MIDI note 0 as falsy in ChannelAnalyzer and DrumNoteMapper. Use `??` (nullish coalescing) instead.
- **Drum counting doubled**: `noteOff` events are counted as `noteOn` in drum analysis. Add event type filter.
- **Scoring weights sum**: ScoringConfig type detection weights sum to 130 instead of 100.
- **Octave wrapping duplicates**: Multiple source notes can wrap to the same target note.
- **Polyphony under-counted**: Duplicate `noteOn` without `noteOff` not tracked; needs `Map<note, count>`.

### UI/Editors (Medium Priority)

- **Drum editor**: Quantize selector is not connected to DrumGridRenderer.
- **Wind editor**: Edit mode is hardcoded to 'pan', preventing note dragging.
- **Tablature editor**: Missing Delete/Backspace and Ctrl+A keyboard shortcuts.
- **Keyboard shortcut inconsistency**: Piano Roll has full shortcuts; other editors are missing Ctrl+Shift+Z (redo).

### CSS/Accessibility (Medium Priority)

- 362 `!important` declarations causing specificity issues.
- CSS variables (`:root`) defined in 4+ files with unpredictable override order.
- 23 `outline: none` without focus alternatives (WCAG violation).

### Performance (Low Priority)

- `MidiRouter` iterates all routes for every MIDI message. Needs source-based indexing.
- `getAllFiles()` loads entire BLOB data column even when metadata-only queries suffice.
- `FilterManager` debounce timers are never cleared on component unmount.

### Infrastructure (Low Priority)

- **ALSA parsing**: `DelayCalibrator` regex uses French keyword `carte` which fails on English systems. Needs multilingual support.
- **Double migration tracking**: Both a `migrations` table and `schema_version` are used. Should unify.
- No rate limiting on WebSocket connections.
