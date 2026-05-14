#!/usr/bin/env bash
# scripts/pi-rt-tune.sh
#
# Idempotent realtime tuning for Raspberry Pi running General-Midi-Boop.
# Applies the OS-side knobs that the realtime audit identified as
# necessary for deterministic MIDI scheduling on a stock Raspberry Pi OS
# (Bookworm 64-bit). Designed for Pi 4 / Pi 5; the Pi 3 path is included
# but marginal — see docs/realtime-pi.md.
#
# Usage:
#   sudo bash scripts/pi-rt-tune.sh           # apply defaults
#   sudo bash scripts/pi-rt-tune.sh --dry-run # show diffs, no writes
#   sudo bash scripts/pi-rt-tune.sh --no-isolcpus  # skip CPU isolation
#   sudo bash scripts/pi-rt-tune.sh --no-bluetooth # disable BT services
#
# Re-runs are safe: every block checks before writing and a `.bak`
# backup of mutated files is created on the first successful write.
#
# Exit codes:
#   0 — success (changes may require a reboot)
#   1 — invocation error (not root, bad flags)
#   2 — unsupported environment (no Pi detected)

set -euo pipefail

# ---------------------------------------------------------------------
# CLI parsing
# ---------------------------------------------------------------------
DRY_RUN=0
WITH_ISOLCPUS=1
DISABLE_BLUETOOTH=0
ISOLATED_CPU=3

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ; shift ;;
        --no-isolcpus) WITH_ISOLCPUS=0 ; shift ;;
        --no-bluetooth) DISABLE_BLUETOOTH=1 ; shift ;;
        --cpu) ISOLATED_CPU="$2" ; shift 2 ;;
        -h|--help)
            sed -n '2,30p' "$0"
            exit 0
            ;;
        *)
            echo "Unknown flag: $1" >&2
            exit 1
            ;;
    esac
done

# ---------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------
if [[ $DRY_RUN -eq 0 && $EUID -ne 0 ]]; then
    echo "ERROR: must run as root (or use --dry-run)" >&2
    exit 1
fi

if [[ ! -f /proc/device-tree/model ]]; then
    echo "ERROR: no /proc/device-tree/model — not a Raspberry Pi?" >&2
    exit 2
fi
PI_MODEL=$(tr -d '\0' < /proc/device-tree/model)
echo "Detected: $PI_MODEL"
case "$PI_MODEL" in
    *"Raspberry Pi 3"*) PI_GEN=3 ;;
    *"Raspberry Pi 4"*) PI_GEN=4 ;;
    *"Raspberry Pi 5"*) PI_GEN=5 ;;
    *)                  PI_GEN=0 ;;
esac
if [[ $PI_GEN -eq 0 ]]; then
    echo "WARNING: unrecognised Pi generation; defaults assume Pi 4."
fi

# Boot config path differs between Bookworm (/boot/firmware) and older
# Bullseye (/boot). We pick the one that exists.
BOOT_FW=""
for candidate in /boot/firmware /boot; do
    if [[ -f "$candidate/cmdline.txt" ]]; then
        BOOT_FW="$candidate"
        break
    fi
done
if [[ -z "$BOOT_FW" ]]; then
    echo "ERROR: no cmdline.txt in /boot/firmware or /boot" >&2
    exit 2
fi
echo "Boot firmware path: $BOOT_FW"

# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------
log_change() { echo "[change] $*"; }
log_skip()   { echo "[skip]   $*"; }
write_or_dry() {
    local path="$1"
    local content="$2"
    if [[ $DRY_RUN -eq 1 ]]; then
        echo "[dry] would write to $path:"
        echo "$content" | sed 's/^/    /'
        return 0
    fi
    if [[ -f "$path" && ! -f "${path}.bak" ]]; then
        cp "$path" "${path}.bak"
    fi
    printf '%s\n' "$content" > "$path"
}
append_kv_once() {
    # append_kv_once <file> <pattern> <new_kv>
    # Adds <new_kv> to the file if no line matches <pattern>.
    local file="$1" pattern="$2" new_kv="$3"
    if grep -Eq "$pattern" "$file"; then
        log_skip "$file already contains $pattern"
        return 0
    fi
    log_change "append '$new_kv' to $file"
    if [[ $DRY_RUN -eq 1 ]]; then
        return 0
    fi
    [[ ! -f "${file}.bak" ]] && cp "$file" "${file}.bak"
    printf '\n%s\n' "$new_kv" >> "$file"
}
append_cmdline_token() {
    # cmdline.txt is single-line. Append a token if absent.
    local file="$1" token="$2"
    if grep -Eq "(^|[[:space:]])${token}([[:space:]]|$)" "$file"; then
        log_skip "$file already has $token"
        return 0
    fi
    log_change "append '$token' to $file"
    if [[ $DRY_RUN -eq 1 ]]; then
        return 0
    fi
    [[ ! -f "${file}.bak" ]] && cp "$file" "${file}.bak"
    # cmdline.txt must remain a single line.
    sed -i -e "s/\\s*$/ $token/" "$file"
}

# ---------------------------------------------------------------------
# 1. CPU governor — performance for every core
# ---------------------------------------------------------------------
echo "--- CPU frequency governor ---"
for policy in /sys/devices/system/cpu/cpufreq/policy*; do
    [[ -e "$policy/scaling_governor" ]] || continue
    current=$(cat "$policy/scaling_governor")
    if [[ "$current" == "performance" ]]; then
        log_skip "$policy already performance"
    else
        log_change "$policy: $current -> performance"
        if [[ $DRY_RUN -eq 0 ]]; then
            echo performance > "$policy/scaling_governor"
        fi
    fi
done

# Persist across reboots via cpufrequtils.
GOV_SYSTEMD=/etc/systemd/system/cpu-governor-performance.service
if [[ ! -f "$GOV_SYSTEMD" ]]; then
    log_change "install $GOV_SYSTEMD"
    write_or_dry "$GOV_SYSTEMD" "[Unit]
Description=Pin every CPU governor to 'performance' for realtime MIDI
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'for g in /sys/devices/system/cpu/cpufreq/policy*/scaling_governor; do echo performance > \"\$g\"; done'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target"
    if [[ $DRY_RUN -eq 0 ]]; then
        systemctl daemon-reload
        systemctl enable cpu-governor-performance.service >/dev/null
    fi
else
    log_skip "$GOV_SYSTEMD already installed"
fi

# ---------------------------------------------------------------------
# 2. cmdline.txt — isolcpus / nohz_full / rcu_nocbs on the chosen core
# ---------------------------------------------------------------------
echo "--- Kernel cmdline ---"
CMDLINE_FILE="$BOOT_FW/cmdline.txt"
if [[ $WITH_ISOLCPUS -eq 1 ]]; then
    append_cmdline_token "$CMDLINE_FILE" "isolcpus=${ISOLATED_CPU}"
    append_cmdline_token "$CMDLINE_FILE" "nohz_full=${ISOLATED_CPU}"
    append_cmdline_token "$CMDLINE_FILE" "rcu_nocbs=${ISOLATED_CPU}"
else
    log_skip "isolcpus disabled by flag"
fi

# ---------------------------------------------------------------------
# 3. /etc/sysctl.d/99-gmboop-rt.conf — VM and scheduler knobs
# ---------------------------------------------------------------------
echo "--- sysctl ---"
SYSCTL_FILE=/etc/sysctl.d/99-gmboop-rt.conf
SYSCTL_CONTENT="# General-Midi-Boop realtime tuning. Generated by scripts/pi-rt-tune.sh
# Less aggressive page-out so a long playback never swaps the audio buffers.
vm.swappiness = 10
# Smaller dirty-page tolerance keeps fsync stalls short and predictable.
vm.dirty_ratio = 10
vm.dirty_background_ratio = 5
# Allow non-root processes to bump real-time priority via systemd units.
kernel.sched_rt_runtime_us = -1"
if [[ -f "$SYSCTL_FILE" ]] && cmp -s <(printf '%s\n' "$SYSCTL_CONTENT") "$SYSCTL_FILE"; then
    log_skip "$SYSCTL_FILE already current"
else
    log_change "write $SYSCTL_FILE"
    write_or_dry "$SYSCTL_FILE" "$SYSCTL_CONTENT"
    if [[ $DRY_RUN -eq 0 ]]; then
        sysctl --system >/dev/null
    fi
fi

# ---------------------------------------------------------------------
# 4. systemd drop-in for gmboop.service — CPU affinity + SCHED_FIFO
# ---------------------------------------------------------------------
echo "--- systemd drop-in ---"
DROPIN_DIR=/etc/systemd/system/gmboop.service.d
DROPIN_FILE="$DROPIN_DIR/realtime.conf"
DROPIN_CONTENT="[Service]
CPUAffinity=${ISOLATED_CPU}
IOSchedulingClass=realtime
IOSchedulingPriority=2
Nice=-15
LimitRTPRIO=80
LimitMEMLOCK=infinity
AmbientCapabilities=CAP_SYS_NICE CAP_IPC_LOCK"
if [[ $DRY_RUN -eq 0 ]]; then
    mkdir -p "$DROPIN_DIR"
fi
if [[ -f "$DROPIN_FILE" ]] && cmp -s <(printf '%s\n' "$DROPIN_CONTENT") "$DROPIN_FILE"; then
    log_skip "$DROPIN_FILE already current"
else
    log_change "write $DROPIN_FILE"
    write_or_dry "$DROPIN_FILE" "$DROPIN_CONTENT"
    if [[ $DRY_RUN -eq 0 ]]; then
        systemctl daemon-reload
    fi
fi

# ---------------------------------------------------------------------
# 5. Bluetooth services off (optional — only if app does not use BLE)
# ---------------------------------------------------------------------
if [[ $DISABLE_BLUETOOTH -eq 1 ]]; then
    echo "--- Bluetooth services ---"
    for svc in bluetooth.service hciuart.service; do
        if systemctl is-enabled "$svc" >/dev/null 2>&1; then
            log_change "disable $svc"
            if [[ $DRY_RUN -eq 0 ]]; then
                systemctl disable --now "$svc" >/dev/null 2>&1 || true
            fi
        else
            log_skip "$svc already disabled"
        fi
    done
fi

# ---------------------------------------------------------------------
# 6. Hardware watchdog
# ---------------------------------------------------------------------
echo "--- Watchdog ---"
append_kv_once "$BOOT_FW/config.txt" "^dtparam=watchdog=on" "dtparam=watchdog=on"
WD_DROPIN=/etc/systemd/system.conf.d/gmboop-watchdog.conf
WD_CONTENT="[Manager]
RuntimeWatchdogSec=60
ShutdownWatchdogSec=10min"
if [[ $DRY_RUN -eq 0 ]]; then
    mkdir -p "$(dirname "$WD_DROPIN")"
fi
if [[ -f "$WD_DROPIN" ]] && cmp -s <(printf '%s\n' "$WD_CONTENT") "$WD_DROPIN"; then
    log_skip "$WD_DROPIN already current"
else
    log_change "write $WD_DROPIN"
    write_or_dry "$WD_DROPIN" "$WD_CONTENT"
fi

echo
echo "Done. Most settings require a reboot to take effect."
echo "Run scripts/check-rt-setup.sh after reboot to verify."
