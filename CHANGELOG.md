# Changelog

All notable changes to Ma-est-tro are documented in this file.

## [5.0.0] - 2026-03-24

### Added
- ESLint configuration with backend/frontend/test overrides
- Prettier and EditorConfig for consistent formatting
- Husky + lint-staged pre-commit hooks
- GitHub Actions CI workflow (lint + test + coverage)
- Environment variable overrides in Config.js (dotenv support)
- `.env.example` template with all supported variables
- Optional token authentication for HTTP and WebSocket (`MAESTRO_API_TOKEN`)
- Helmet.js security headers
- Log file rotation (10 MB max, 5 rotated files)
- Structured JSON logging format option (`logging.jsonFormat`)
- Test coverage reporting (`npm run test:coverage`)
- Unit tests for ServiceContainer, EventBus, Config, Logger, dbHelpers, errors (68 new tests)
- Dockerfile and docker-compose.yml for containerization
- Automated database backup scheduler (daily, 7-day retention)
- Structured error hierarchy (ApplicationError, ValidationError, NotFoundError, etc.)
- `buildDynamicUpdate` helper to reduce DRY violations in database code
- Prometheus-compatible `/api/metrics` endpoint
- Down migration support with `npm run migrate:rollback`
- Architecture overview document (ARCHITECTURE.md)
- API reference document (docs/API.md) covering 146 commands
- Contributing guide (CONTRIBUTING.md)

### Fixed
- `device` variable scoping bug in BluetoothManager.js catch block

### Security
- npm audit fix for ajv and flatted vulnerabilities
