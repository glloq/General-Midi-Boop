# Deployment

Three supported deployment modes. Pick one — they're alternatives, not stages.

## 1. Direct Node.js

```bash
npm start
```

Simple, foreground process. Useful for development and bench testing. Configuration via `config.json` and `.env` ([[Installation]] covers the full list).

## 2. PM2

PM2 keeps the process alive and restarts on crash. Configuration is committed in [`ecosystem.config.cjs`](https://github.com/glloq/General-Midi-Boop/blob/main/ecosystem.config.cjs).

```bash
npm run pm2:start    # start
npm run pm2:stop     # stop
npm run pm2:restart  # restart
npm run pm2:logs     # tail logs
npm run pm2:status   # process state
```

Pair with `pm2 startup` and `pm2 save` to survive reboots.

## 3. Docker

[`docker-compose.yml`](https://github.com/glloq/General-Midi-Boop/blob/main/docker-compose.yml) and [`Dockerfile`](https://github.com/glloq/General-Midi-Boop/blob/main/Dockerfile) ship with the repo.

```bash
docker-compose up -d   # start, detached
docker-compose logs -f # tail logs
docker-compose down    # stop
```

The container exposes port 8080 by default; mount `./data` if you want the SQLite database to persist outside the container.

## systemd Unit

The automated installer ([`scripts/Install.sh`](https://github.com/glloq/General-Midi-Boop/blob/main/scripts/Install.sh)) installs a `gmboop.service` unit. Manage it with the standard commands:

```bash
sudo systemctl start gmboop
sudo systemctl stop gmboop
sudo systemctl restart gmboop
sudo systemctl status gmboop
sudo journalctl -u gmboop -f   # tail journal
```

## Updating

```bash
git pull
npm install
npm run migrate    # apply any new SQLite migrations
sudo systemctl restart gmboop  # or pm2 restart / docker compose up -d
```

The helper [`scripts/update.sh`](https://github.com/glloq/General-Midi-Boop/blob/main/scripts/update.sh) automates pull + install + migrate + restart.

## Backups

A scheduled backup runs daily via [`src/persistence/BackupScheduler.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/persistence/BackupScheduler.js). Backups are written next to the live database. Keep an off-host copy if your data matters.

## Monitoring

- `GET /api/health` — liveness probe (no auth).
- `GET /api/status` — device, route, file counts and memory usage (auth required).
- `GET /api/metrics` — Prometheus-compatible scrape endpoint (auth required).

When `GMBOOP_API_TOKEN` is set, pass `Authorization: Bearer <token>` to the authenticated endpoints.

## Logging

JSON-structured logs with rotation, configured via `GMBOOP_LOG_FILE` and `GMBOOP_LOG_LEVEL`. The default rotation is handled by [`src/core/Logger.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/core/Logger.js).
