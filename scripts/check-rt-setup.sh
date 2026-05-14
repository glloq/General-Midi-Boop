#!/usr/bin/env bash
# scripts/check-rt-setup.sh
#
# Diagnostic: verify that the realtime tuning applied by pi-rt-tune.sh
# is actually in effect. Designed to be safe to run from a healthcheck
# (no root required, no side effects).
#
# Exit codes:
#   0 — every check passed
#   1 — at least one check failed (run with -v for details)

set -uo pipefail

VERBOSE=0
[[ "${1:-}" == "-v" || "${1:-}" == "--verbose" ]] && VERBOSE=1

ok=0
fail=0
warn=0
pass()  { ok=$((ok+1));   [[ $VERBOSE -eq 1 ]] && echo "[ok]   $*"; }
miss()  { fail=$((fail+1)); echo "[FAIL] $*"; }
hint()  { warn=$((warn+1)); echo "[warn] $*"; }

# 1. CPU governor
mismatch=0
for gov in /sys/devices/system/cpu/cpufreq/policy*/scaling_governor; do
    [[ -e "$gov" ]] || continue
    [[ "$(cat "$gov")" == "performance" ]] || { mismatch=1; break; }
done
if [[ $mismatch -eq 0 ]]; then
    pass "cpufreq governor is performance on every policy"
else
    miss "at least one cpufreq governor is not performance"
fi

# 2. cmdline.txt isolcpus
CMDLINE=""
for f in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
    [[ -f "$f" ]] && { CMDLINE="$f"; break; }
done
if [[ -n "$CMDLINE" ]]; then
    if grep -q "isolcpus=" "$CMDLINE"; then
        pass "isolcpus present in $CMDLINE"
    else
        hint "no isolcpus= in $CMDLINE (acceptable on Pi 3 or if --no-isolcpus was used)"
    fi
else
    miss "no cmdline.txt found"
fi

# 3. sysctl knobs
get_sysctl() { sysctl -n "$1" 2>/dev/null || echo ""; }
[[ "$(get_sysctl vm.swappiness)" == "10" ]]              && pass "vm.swappiness=10"              || miss "vm.swappiness != 10"
[[ "$(get_sysctl vm.dirty_ratio)" == "10" ]]             && pass "vm.dirty_ratio=10"             || miss "vm.dirty_ratio != 10"
[[ "$(get_sysctl vm.dirty_background_ratio)" == "5" ]]   && pass "vm.dirty_background_ratio=5"   || miss "vm.dirty_background_ratio != 5"
RT_RT=$(get_sysctl kernel.sched_rt_runtime_us)
[[ "$RT_RT" == "-1" || "$RT_RT" == "" ]] && pass "kernel.sched_rt_runtime_us=$RT_RT" || hint "kernel.sched_rt_runtime_us=$RT_RT (expected -1)"

# 4. systemd drop-in
[[ -f /etc/systemd/system/gmboop.service.d/realtime.conf ]] \
    && pass "gmboop.service realtime drop-in installed" \
    || miss "missing /etc/systemd/system/gmboop.service.d/realtime.conf"

# 5. node process — scheduling class + CPU mask (best-effort)
NODE_PID=$(pgrep -f 'node.*server.js' | head -n1 || true)
if [[ -n "$NODE_PID" ]]; then
    SCHED=$(chrt -p "$NODE_PID" 2>/dev/null | head -1 | awk '{print $NF}')
    if [[ "$SCHED" == "SCHED_FIFO" || "$SCHED" == "SCHED_RR" ]]; then
        pass "node running under $SCHED"
    else
        hint "node running under $SCHED (consider chrt -f 30 -p $NODE_PID)"
    fi
    MASK=$(taskset -p "$NODE_PID" 2>/dev/null | awk '{print $NF}')
    pass "node CPU affinity mask = $MASK"
else
    hint "node server.js not running — skipping per-process checks"
fi

# 6. cyclictest available? (advisory)
command -v cyclictest >/dev/null 2>&1 \
    && pass "cyclictest available (apt install rt-tests to refresh)" \
    || hint "cyclictest not installed (apt install rt-tests for jitter measurement)"

echo "----------------------------------------"
echo "OK=$ok WARN=$warn FAIL=$fail"
[[ $fail -eq 0 ]] && exit 0 || exit 1
