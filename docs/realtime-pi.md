# Realtime Raspberry Pi setup for General-Midi-Boop

The MIDI scheduler is deterministic up to the limits imposed by the
underlying OS. On a stock Raspberry Pi OS install, scheduling jitter
can spike to 5-15 ms under load — enough to make a mechanical
orchestra sound sloppy. This guide describes the OS-side tuning that
the project relies on for sub-millisecond jitter.

Scope: tested on **Raspberry Pi 4 (2 GB+)** and **Pi 5 (4 GB+)** with
**Raspberry Pi OS Bookworm 64-bit**. The Pi 3 path works but is
marginal — see notes at the end.

---

## Quick start

```bash
# 1. Make sure the project is checked out and dependencies are up to date.
cd /opt/gmboop
npm ci

# 2. Apply the OS tuning (writes /boot/firmware/cmdline.txt,
#    /etc/sysctl.d/99-gmboop-rt.conf, a systemd drop-in for the
#    gmboop service, and a hardware-watchdog config).
sudo bash scripts/pi-rt-tune.sh           # apply with defaults
# Optional: skip CPU isolation on a Pi 3
sudo bash scripts/pi-rt-tune.sh --no-isolcpus
# Optional: disable the Bluetooth stack (only if the app doesn't need BLE)
sudo bash scripts/pi-rt-tune.sh --no-bluetooth
# Dry run first if you want to inspect every change:
sudo bash scripts/pi-rt-tune.sh --dry-run

# 3. Reboot — cmdline + watchdog only take effect after a reboot.
sudo reboot

# 4. After reboot, verify the setup is live.
bash scripts/check-rt-setup.sh -v
```

The verifier returns `0` when every required knob is in effect. Use it
from a healthcheck or systemd `ExecStartPre` if you want a hard fail
on misconfigured boots.

---

## What `pi-rt-tune.sh` does

| Setting                              | Where                                                                    | Why                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `governor=performance` on every core | `/sys/devices/system/cpu/cpufreq/policy*/scaling_governor` + systemd unit | Prevents DVFS-induced jitter; CPU stays at max turbo so timers fire predictably.          |
| `isolcpus=3 nohz_full=3 rcu_nocbs=3` | `/boot/firmware/cmdline.txt`                                             | Reserves CPU3 for the Node process; kernel scheduler stops migrating other tasks onto it. |
| `vm.swappiness=10`                   | `/etc/sysctl.d/99-gmboop-rt.conf`                                        | Almost never swap pages out — protects MIDI buffers from being paged.                     |
| `vm.dirty_ratio=10` / `bg=5`         | same                                                                     | Keeps fsync stalls short and predictable.                                                 |
| `kernel.sched_rt_runtime_us=-1`      | same                                                                     | Lets the gmboop service run SCHED_FIFO without the 95%-ceiling throttle.                  |
| `CPUAffinity=3` + `Nice=-15`         | `/etc/systemd/system/gmboop.service.d/realtime.conf`                     | Pins the Node process to the isolated CPU; bumps nice for the kernel scheduler.           |
| `LimitRTPRIO=80` + `CAP_SYS_NICE`    | same                                                                     | Lets the Node process self-elevate to `SCHED_FIFO` via `chrt`.                            |
| `dtparam=watchdog=on` + 60s timer    | `/boot/firmware/config.txt` and `/etc/systemd/system.conf.d/`            | Hardware watchdog reboots the Pi if the kernel locks up; systemd pings it every 60s.      |

Re-running the script is safe: every block detects already-applied
state and prints `[skip]`. The first write to a file creates a `.bak`
backup.

---

## Manual one-off boosts

After deployment, two extra commands take effect immediately (no
reboot):

```bash
# 1. Bump the running Node process to SCHED_FIFO priority 30.
sudo chrt -f 30 -p $(pgrep -f "node.*server.js")

# 2. Pin it to the isolated CPU (already covered by the systemd
#    drop-in, but useful when running outside systemd).
sudo taskset -cp 3 $(pgrep -f "node.*server.js")
```

When running under PM2 (the default), the systemd drop-in handles
affinity / nice; `chrt` is the only manual step.

---

## Measuring jitter

Install the `rt-tests` package:

```bash
sudo apt install -y rt-tests
```

### Baseline — kernel-level scheduler jitter

```bash
cyclictest -p 80 -m -d 0 -i 200 -t 1 -n -l 1000000
```

Targets (idle Pi after tuning):

|         | Stock kernel | After `pi-rt-tune.sh` | PREEMPT_RT |
| ------- | -----------: | --------------------: | ---------: |
| Pi 4 avg | < 20 µs | < 10 µs | < 5 µs |
| Pi 4 max | 200-500 µs | < 300 µs | < 80 µs |
| Pi 4 max under playback | 5-15 ms | < 2 ms | < 500 µs |

If the Max stays above 1 ms under playback, suspect: an active
Bluetooth stack, Wi-Fi power save, a SD-card I/O storm (logging or
DB backup running during a benchmark).

### Application-level jitter

The bundled benchmark exercises the playback hot path:

```bash
npm run bench   # currently: tests/performance/benchmark.js
```

The Phase F additions (see `tests/performance/benchmark.js`) extend
the run with three scenarios that print histograms:

- **bench-playback-jitter** — emits 10 000 events from a reference
  MIDI and reports `actual - expected` per event. p99 should sit
  under 5 ms.
- **bench-ws-flood** — simulates a slow WebSocket client; reports
  event-loop lag, RSS delta and `WsOutputQueue.droppedByClient`.
- **bench-snapshot-mutation** — fires 100 `instrument_settings_changed`
  during playback to validate that the snapshot insulates the scheduler.

---

## Optional: PREEMPT_RT kernel

For sub-millisecond Max jitter you need a fully-preemptible kernel:

1. Identify the kernel package matching your hardware
   (`linux-image-rpi-v8` on Pi 4 Bookworm 64-bit).
2. If a PREEMPT_RT build is available for it, install it; otherwise
   build from the kernel source with `PREEMPT_RT` patches matching
   the upstream version. Raspberry Pi Foundation does not ship an RT
   kernel by default.
3. Validate compatibility with the native add-ons used by GMBoop:
   - `better-sqlite3` — OK on RT.
   - `easymidi` — uses ALSA, OK.
   - `serialport` — OK.
   - `pigpio` — **needs verification**; the daemon's busy-wait
     interacts poorly with strict RT priorities. Test before relying
     on it in production.
   - `rpi-ws281x-native` — uses DMA, OK.
4. Re-run `cyclictest` after switching kernels; you should see max
   jitter drop to the µs range.

The application code itself does not need to change.

---

## Pi 3 / Pi Zero notes

The Pi 3 B/B+ works but with caveats:

- 1 GB RAM is tight. Cap the heap explicitly:
  `NODE_HEAP_MB=256 pm2 start ecosystem.config.cjs`.
- `isolcpus` on a 4-core Pi 3 reduces the effective core count by 25%.
  If you see CPU saturation, run with `--no-isolcpus`.
- The 32-bit kernel (still common on Pi 3) has slightly worse RT
  characteristics. Prefer the 64-bit Bookworm image.
- `pigpio` PWM and `rpi-ws281x` DMA share resources with audio on
  some Pi 3 revisions. Test with the actual LED hardware before
  committing to a wiring.

The Pi Zero is not supported: too little RAM and a single core.

---

## Rolling back

`pi-rt-tune.sh` keeps a `.bak` copy of every file it mutates. To
revert:

```bash
for f in /boot/firmware/cmdline.txt /boot/firmware/config.txt \
         /etc/sysctl.d/99-gmboop-rt.conf \
         /etc/systemd/system/gmboop.service.d/realtime.conf \
         /etc/systemd/system.conf.d/gmboop-watchdog.conf; do
    [[ -f "${f}.bak" ]] && sudo mv "${f}.bak" "$f"
done
sudo systemctl daemon-reload
sudo systemctl disable cpu-governor-performance.service
sudo reboot
```

---

## Troubleshooting

**`check-rt-setup.sh` reports FAIL on governor** — verify
`/sys/devices/system/cpu/cpufreq/policy0/scaling_governor`; some
distros need the `cpufrequtils` package. The bundled
`cpu-governor-performance.service` solves the persistence issue but
only on next boot.

**Node still runs SCHED_OTHER** — the systemd drop-in grants
`CAP_SYS_NICE`, but the process itself must call `sched_setscheduler`
or you must invoke `sudo chrt -f 30 -p $PID` after boot. PM2 does not
do this automatically.

**RSS climbs over 24 h** — first suspect the WebSocket output queue:
`curl -s localhost:8080/api/metrics | jq` and watch
`outputQueue.droppedByClient` / `bufferedAmount`. A pinned slow
client surfaces here.

**Watchdog reboots the Pi** — the systemd `RuntimeWatchdogSec=60`
fires when systemd itself fails to ping the kernel. In practice this
means the kernel is locked up; look at `/var/log/kern.log` after the
reboot.
