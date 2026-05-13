// ecosystem.config.cjs
//
// Heap and memory-restart limits are sized for the target hardware:
//   - Pi 3 (1 GB RAM)   : NODE_HEAP_MB=256, restart at 320M
//   - Pi 4 (2 GB+)      : NODE_HEAP_MB=512 (default), restart at 600M
//   - Pi 5 (4 GB+)      : NODE_HEAP_MB=768, restart at 900M
//
// Override per host via environment, e.g.:
//   NODE_HEAP_MB=256 NODE_MEM_RESTART_MB=320 pm2 start ecosystem.config.cjs
//
// `--expose-gc` is enabled so the benchmark suite and operator tooling
// can force a major GC between runs without restarting the process.
const HEAP_MB = parseInt(process.env.NODE_HEAP_MB || '512', 10);
const MEM_RESTART_MB = parseInt(process.env.NODE_MEM_RESTART_MB || String(Math.max(HEAP_MB + 100, 600)), 10);

module.exports = {
  apps: [
    {
      name: 'gmboop',
      cwd: __dirname,
      script: './server.js',
      node_args: `--max-old-space-size=${HEAP_MB} --expose-gc`,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: `${MEM_RESTART_MB}M`,
      env: {
        NODE_ENV: 'production',
        PORT: 8080
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      listen_timeout: 10000,
      kill_timeout: 5000
    }
  ]
};