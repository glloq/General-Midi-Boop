#!/bin/bash

# ============================================================================
# GeneralMidiBoop Update Script
# Pulls latest changes from GitHub and updates the system
#
# Key design: the server stays RUNNING during git pull + npm install.
# Only a single atomic restart happens at the end. This avoids the server
# being down for minutes during npm install on slow devices (RPi).
#
# Safety net (audit F-120 / F-121):
#   * a RESTORE POINT is taken before anything is touched — git revision,
#     branch, a copy of config.json, and (just before migrating) a copy of
#     the database;
#   * steps are CRITICAL (npm install, migrations, restart + port check) or
#     COSMETIC (production web bundle). A critical failure ROLLS BACK to the
#     restore point, restarts the server on the previous version and reports
#     "failed: ..."; a cosmetic failure is a warning and the update carries on;
#   * config.json — a tracked file the operator edits in place — is snapshotted
#     and restored after every git operation, so neither the auto-stash nor
#     `git reset --hard` can eat it;
#   * the restore point stays marked in-progress on disk, so a run killed by a
#     power cut is detected (and config.json put back) at the next run.
#
# Order of operations is dictated by rollback-ability: migrations can only run
# AFTER the pull (the new migration files do not exist before it) and BEFORE
# the restart (the new code needs the new schema). Since SQL migrations have
# no down-step, the pre-migration database copy is the only way back.
#
# Environment knobs:
#   UPDATE_ROLLBACK=0   keep the legacy "warn and carry on" behaviour
#   GMBOOP_UPDATE_LIB_ONLY=1  source the helpers without running anything
# ============================================================================

# Non-interactive mode (called from web UI)
NON_INTERACTIVE="${NON_INTERACTIVE:-0}"
if [[ "$1" == "--non-interactive" ]]; then
    NON_INTERACTIVE=1
fi

# Library mode. With GMBOOP_UPDATE_LIB_ONLY=1 the script defines its helper
# functions and returns *before* the main update flow: nothing is stashed,
# pulled, installed or restarted. This is how tests/audit/r9-*.test.js
# exercises the restore-point / rollback logic against a throwaway repository
# without ever running an update on the host.
_GMBOOP_LIB_ONLY="${GMBOOP_UPDATE_LIB_ONLY:-0}"

# Log/status files — use project logs/ dir to avoid /tmp permission conflicts
SCRIPT_DIR_EARLY="$( cd "$( dirname "${BASH_SOURCE[0]}" )" 2>/dev/null && pwd )"
PROJECT_DIR_EARLY="$( cd "$SCRIPT_DIR_EARLY/.." 2>/dev/null && pwd )"
# Defined early so the restore-point helpers work in library mode too; the
# main flow re-derives them identically further down.
SCRIPT_DIR="$SCRIPT_DIR_EARLY"
PROJECT_DIR="$PROJECT_DIR_EARLY"
LOG_FILE="${PROJECT_DIR_EARLY}/logs/update.log"
STATUS_FILE="${PROJECT_DIR_EARLY}/logs/update-status"
# Restore point lives under logs/, which is gitignored: neither
# `git reset --hard` nor `git clean` can take it away mid-rollback.
RESTORE_DIR="${PROJECT_DIR_EARLY}/logs/update-restore"
mkdir -p "${PROJECT_DIR_EARLY}/logs" 2>/dev/null || true

# Immediate startup marker - BEFORE any redirect, so we know bash started
if [ "$_GMBOOP_LIB_ONLY" != "1" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') script_started pid=$$ non_interactive=$NON_INTERACTIVE" > "$STATUS_FILE" 2>/dev/null
fi

# Double-fork: escape the parent process tree so PM2 treekill cannot reach us.
# PM2 kills all descendants by PPID when stopping a process.  Even with
# detached:true (setsid) from Node.js, our PPID still points to the server
# while it is alive.  Re-executing via setsid & exit makes the new instance
# an orphan (PPID=1) that PM2 cannot find.
# Only detach in non-interactive mode (web UI) — in SSH, run directly so the
# user can see output in the terminal.
if [ "$_GMBOOP_LIB_ONLY" != "1" ] && [ "$NON_INTERACTIVE" = "1" ] && [ -z "$_GMBOOP_UPDATE_DETACHED" ]; then
    export _GMBOOP_UPDATE_DETACHED=1
    setsid "$0" "$@" &
    exit 0
fi

if [ "$_GMBOOP_LIB_ONLY" != "1" ] && [ "$NON_INTERACTIVE" = "1" ]; then
    # Note: when spawned from Node.js, stdout/stderr already point to the log file
    # via stdio fd passthrough. This exec is a safety net for manual runs.
    exec > "$LOG_FILE" 2>&1
fi

# Write status marker for external monitoring (frontend, diagnostics)
_update_status() {
    echo "$1" > "$STATUS_FILE" 2>/dev/null || true
}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
print_header() {
    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}▶ $1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

# Abort update — server was never stopped, so it is still running
abort_and_restart() {
    _update_status "failed: $1"
    print_error "Update aborted: $1"
    print_info "Server was not stopped — still running with previous version."
    exit 1
}

# ============================================================================
# Restore point and rollback  (audit F-120 / F-121)
# ============================================================================
#
# STEP CRITICALITY — the whole point of this section.
#
#   CRITICAL : the box is unusable if the step fails. New code with old
#              dependencies means a missing import at boot, i.e. an infinite
#              systemd/PM2 restart loop on a machine nobody is watching.
#              -> automatic rollback to the restore point, status "failed: ...".
#              Critical steps: npm install, database migrations, restart +
#              port verification.
#
#   COSMETIC : degraded but bootable. The production web bundle is the only
#              one today: when `npm run build` fails the server falls back to
#              the unbundled public/ tree and still serves the UI.
#              -> warning, the update carries on.
#
# Before this section EVERY post-pull failure was a warning and the script
# still exited 0 with a half-updated installation.

# Set UPDATE_ROLLBACK=0 to keep the legacy "warn and carry on" behaviour
# (useful when debugging an update by hand over SSH).
UPDATE_ROLLBACK="${UPDATE_ROLLBACK:-1}"

RESTORE_ARMED=false      # true once a usable restore point exists
MIGRATIONS_RAN=false     # true once `npm run migrate` has been started
STASH_CREATED=false      # true when local changes were auto-stashed
PREV_HEAD=""             # revision the update started from
PREV_BRANCH=""           # branch the update started from ("" = detached)
DB_SNAPSHOT=""           # pre-migration copy of the SQLite database

# Resolve the SQLite database path from config.json, falling back to the
# shipped default. Used to snapshot the database before migrating it.
_db_path() {
    local p=""
    if [ -f "$PROJECT_DIR/config.json" ] && command -v node &> /dev/null; then
        p=$(node -p "try{JSON.parse(require('fs').readFileSync('$PROJECT_DIR/config.json','utf8')).database.path||''}catch(e){''}" 2>/dev/null)
    fi
    if [ -z "$p" ] || [ "$p" = "undefined" ] || [ "$p" = "null" ]; then
        p="./data/gmboop.db"
    fi
    case "$p" in
        /*) echo "$p" ;;
        *)  echo "$PROJECT_DIR/${p#./}" ;;
    esac
}

# --- config.json ------------------------------------------------------------
# config.json is a TRACKED file the operator edits in place (port, database
# path on an external SSD, security.mode, ble/serial toggles). `git stash`,
# `git checkout` and `git reset --hard` all clobber it (audit F-121), and the
# stash it lands in is one the operator will never find. We keep a copy
# outside git and put it back after every git operation, including rollback.
_snapshot_config() {
    [ -f "$PROJECT_DIR/config.json" ] || return 0
    mkdir -p "$RESTORE_DIR" 2>/dev/null || true
    cp -p "$PROJECT_DIR/config.json" "$RESTORE_DIR/config.json" 2>/dev/null || return 1
    return 0
}

_restore_config() {
    [ -f "$RESTORE_DIR/config.json" ] || return 0
    if [ -f "$PROJECT_DIR/config.json" ] && command -v cmp &> /dev/null; then
        if cmp -s "$RESTORE_DIR/config.json" "$PROJECT_DIR/config.json"; then
            return 0    # untouched by the git operation, nothing to do
        fi
    fi
    if cp -p "$RESTORE_DIR/config.json" "$PROJECT_DIR/config.json" 2>/dev/null; then
        print_success "config.json restored from the restore point (operator settings preserved)"
        return 0
    fi
    print_error "Could not restore config.json — your copy is kept at $RESTORE_DIR/config.json"
    return 1
}

# --- database ---------------------------------------------------------------
# SQL migrations have no down-step, so the only way back is a file copy taken
# BEFORE `npm run migrate` runs.
_snapshot_database() {
    local db
    db="$(_db_path)"
    if [ ! -f "$db" ]; then
        print_info "No database at $db — nothing to snapshot"
        return 0
    fi
    mkdir -p "$PROJECT_DIR/backups" 2>/dev/null || true
    local dest="$PROJECT_DIR/backups/pre-update-$(date '+%Y%m%d-%H%M%S').db"

    if command -v sqlite3 &> /dev/null; then
        # Consistent online copy: the server is still running and holds the
        # database open in WAL mode.
        if sqlite3 "$db" ".backup '$dest'" 2>&1; then
            DB_SNAPSHOT="$dest"
        fi
    fi
    if [ -z "$DB_SNAPSHOT" ]; then
        # No sqlite3 CLI: copy the main file plus its WAL sidecars together.
        if cp "$db" "$dest" 2>/dev/null; then
            [ -f "$db-wal" ] && cp "$db-wal" "$dest-wal" 2>/dev/null
            [ -f "$db-shm" ] && cp "$db-shm" "$dest-shm" 2>/dev/null
            DB_SNAPSHOT="$dest"
        fi
    fi

    if [ -n "$DB_SNAPSHOT" ]; then
        mkdir -p "$RESTORE_DIR" 2>/dev/null || true
        printf '%s\n' "$DB_SNAPSHOT" > "$RESTORE_DIR/db-snapshot"
        print_success "Database snapshot: $(basename "$DB_SNAPSHOT")"
        return 0
    fi
    print_warning "Could not snapshot the database — migrations will not be rollback-able"
    return 1
}

# Put the pre-migration database back. The migrated file is MOVED aside
# (never deleted) so both copies survive a rollback that itself goes wrong.
# Caveat: the old server process still holds the migrated file open, so the
# handful of writes it makes between the copy and the restart are lost. That
# is the price of keeping the server up during the update.
_restore_database() {
    if [ -z "$DB_SNAPSHOT" ] || [ ! -f "$DB_SNAPSHOT" ]; then
        print_warning "No database snapshot to restore"
        return 1
    fi
    local db ts f
    db="$(_db_path)"
    ts=$(date '+%Y%m%d-%H%M%S')
    for f in "$db" "$db-wal" "$db-shm"; do
        if [ -f "$f" ]; then
            mv "$f" "$f.failed-update-$ts" 2>/dev/null || true
        fi
    done
    if cp "$DB_SNAPSHOT" "$db" 2>/dev/null; then
        [ -f "$DB_SNAPSHOT-wal" ] && cp "$DB_SNAPSHOT-wal" "$db-wal" 2>/dev/null
        [ -f "$DB_SNAPSHOT-shm" ] && cp "$DB_SNAPSHOT-shm" "$db-shm" 2>/dev/null
        print_success "Database restored from $(basename "$DB_SNAPSHOT") (migrated copy kept as *.failed-update-$ts)"
        return 0
    fi
    print_error "Could not restore the database — snapshot kept at $DB_SNAPSHOT"
    return 1
}

# --- restore point ----------------------------------------------------------
_create_restore_point() {
    mkdir -p "$RESTORE_DIR" 2>/dev/null || true
    PREV_HEAD=$(git rev-parse HEAD 2>/dev/null)
    if [ -z "$PREV_HEAD" ]; then
        print_error "Cannot read the current git revision"
        return 1
    fi
    PREV_BRANCH=$(git branch --show-current 2>/dev/null)
    printf '%s\n' "$PREV_HEAD" > "$RESTORE_DIR/head"
    printf '%s\n' "$PREV_BRANCH" > "$RESTORE_DIR/branch"
    printf '%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" > "$RESTORE_DIR/created-at"
    rm -f "$RESTORE_DIR/db-snapshot" 2>/dev/null || true
    if ! _snapshot_config; then
        print_warning "config.json could not be snapshotted"
    fi
    # Marker file: still present at the next run == the previous update died
    # mid-flight (power cut, kill -9).
    : > "$RESTORE_DIR/in-progress"
    RESTORE_ARMED=true
    print_success "Restore point: ${PREV_HEAD:0:7} on '${PREV_BRANCH:-<detached>}' (config.json saved)"
    return 0
}

_clear_restore_point() {
    rm -f "$RESTORE_DIR/in-progress" 2>/dev/null || true
    RESTORE_ARMED=false
}

# A restore point still marked in-progress means the previous run never
# reached its end (power cut is the case the audit calls out). We do NOT
# revert the code automatically — the box may have been running happily on
# the new revision for weeks — but we do put config.json back, because that
# is always safe, and we print the exact recovery command.
_check_stale_restore_point() {
    [ -f "$RESTORE_DIR/in-progress" ] || return 0
    local head branch created
    head=$(cat "$RESTORE_DIR/head" 2>/dev/null)
    branch=$(cat "$RESTORE_DIR/branch" 2>/dev/null)
    created=$(cat "$RESTORE_DIR/created-at" 2>/dev/null)
    print_warning "A previous update never finished (restore point taken ${created:-at an unknown time})."
    print_warning "It started from ${head:-unknown} on branch '${branch:-<detached>}'."
    _restore_config || true
    print_info "If this installation is broken, recover with: git -C \"$PROJECT_DIR\" reset --hard ${head:-<previous-head>}"
    rm -f "$RESTORE_DIR/in-progress" 2>/dev/null || true
}

# A power cut during `git pull` leaves .git/index.lock behind and every later
# git command fails until it is removed — system_check_update and update.sh
# included (audit F-120, power-cut analysis). Only a lock old enough that it
# cannot belong to a live command is removed.
_clear_orphan_index_lock() {
    local lock="$PROJECT_DIR/.git/index.lock"
    [ -f "$lock" ] || return 0
    local now mtime age
    now=$(date +%s)
    mtime=$(stat -c %Y "$lock" 2>/dev/null || echo 0)
    age=$(( now - mtime ))
    if [ "$age" -gt "${INDEX_LOCK_MAX_AGE:-600}" ]; then
        if rm -f "$lock" 2>/dev/null; then
            print_warning "Removed orphan .git/index.lock (${age}s old)"
            return 0
        fi
        print_error "Orphan .git/index.lock could not be removed: $lock"
        return 1
    fi
    print_warning ".git/index.lock is present (${age}s old) — another git process may be running"
    return 1
}

# --- rollback ---------------------------------------------------------------
# Undo everything a failed update did: code, configuration, database,
# dependencies — then bring the server back on the previous version and
# report the failure. Terminal: this function never returns.
_rollback() {
    local reason="$1"

    print_header "ROLLBACK"
    print_error "Critical step failed: $reason"

    if [ "$UPDATE_ROLLBACK" != "1" ]; then
        _restore_config || true
        _update_status "failed: $reason (rollback disabled)"
        print_error "Rollback disabled (UPDATE_ROLLBACK=0) — tree left as-is."
        exit 1
    fi

    if [ "$RESTORE_ARMED" != true ] || [ -z "$PREV_HEAD" ]; then
        _restore_config || true
        _update_status "failed: $reason (no restore point)"
        print_error "No restore point available — cannot roll back automatically."
        exit 1
    fi

    _update_status "rolling_back"

    # 1. Code back to the exact revision we started from.
    if [ -n "$PREV_BRANCH" ]; then
        git checkout -f "$PREV_BRANCH" 2>&1 || print_warning "Could not check out '$PREV_BRANCH'"
    fi
    if git reset --hard "$PREV_HEAD" 2>&1; then
        print_success "Code restored to ${PREV_HEAD:0:7}"
    else
        print_error "git reset --hard $PREV_HEAD FAILED — manual recovery required"
    fi

    # 2. Operator configuration (the reset above just clobbered it).
    _restore_config || true

    # 3. Database, only when migrations were actually started.
    if [ "$MIGRATIONS_RAN" = true ]; then
        _restore_database || true
    fi

    # 4. Dependencies matching the RESTORED package.json.
    print_info "Reinstalling dependencies for the restored revision..."
    if npm install 2>&1; then
        print_success "Dependencies restored"
    else
        print_warning "npm install failed during rollback — node_modules may still hold the new tree"
    fi

    # 5. Server back up on the old code.
    if _restart_server; then
        print_success "Server restarted on the previous version"
    else
        print_error "Server restart failed after rollback — manual intervention required"
    fi

    _clear_restore_point
    _update_status "failed: $reason (rolled back to ${PREV_HEAD:0:7})"
    print_error "Update rolled back. Installation is back on ${PREV_HEAD:0:7}."
    if [ "$STASH_CREATED" = true ]; then
        print_info "Your stashed local changes are still there: git stash list"
    fi
    exit 1
}

# Sugar so the call sites read as what they are.
_critical_failure() {
    _rollback "$1"
}

# SIGINT/SIGTERM during the update (a power cut cannot be trapped — the
# in-progress marker covers that case at the next run).
_on_signal() {
    trap - INT TERM
    print_error "Update interrupted by a signal"
    if [ "$RESTORE_ARMED" = true ]; then
        _rollback "interrupted"
    fi
    _update_status "failed: interrupted"
    exit 1
}

# Restart server helper — simple version with one fallback per method
_restart_server() {
    local RESTART_OK=false

    if [ "$PM2_MANAGED" = true ]; then
        print_info "Restarting with PM2 (atomic restart)..."
        if pm2 restart gmboop --update-env 2>&1; then
            sleep 3
            if pm2 list | grep -q "online.*gmboop"; then
                RESTART_OK=true
                print_success "PM2 restart successful"
            fi
        fi
        # Fallback: delete + start from ecosystem file
        if [ "$RESTART_OK" = false ]; then
            print_warning "PM2 restart failed, trying delete + start..."
            pm2 delete gmboop 2>/dev/null || true
            sleep 1
            if pm2 start ecosystem.config.cjs 2>&1; then
                pm2 save 2>/dev/null || true
                sleep 5
                if pm2 list | grep -q "online.*gmboop"; then
                    RESTART_OK=true
                    print_success "PM2 delete+start successful"
                else
                    print_warning "PM2 process not online after start"
                    pm2 list || true
                    pm2 logs gmboop --lines 20 --nostream 2>/dev/null || true
                fi
            fi
        fi
    elif [ "$SYSTEMD_MANAGED" = true ]; then
        print_info "Restarting with systemd..."
        if timeout 10 sudo -n systemctl restart gmboop 2>/dev/null; then
            sleep 3
            if systemctl is-active --quiet gmboop 2>/dev/null; then
                RESTART_OK=true
                print_success "Systemd restart successful"
            else
                print_warning "Systemd restart may have failed"
            fi
        else
            print_warning "Systemd restart failed (sudo password required?)"
        fi
    elif [ "$PM2_AVAILABLE" = true ]; then
        print_info "Starting fresh with PM2..."
        pm2 delete gmboop 2>/dev/null || true
        sleep 1
        if pm2 start ecosystem.config.cjs 2>&1; then
            pm2 save 2>/dev/null || true
            sleep 5
            if pm2 list | grep -q "online.*gmboop"; then
                RESTART_OK=true
                print_success "PM2 start successful"
            else
                print_warning "PM2 start may have failed"
                pm2 list || true
                pm2 logs gmboop --lines 20 --nostream 2>/dev/null || true
            fi
        fi
    fi

    # Fallback: kill by port + direct node start
    if [ "$RESTART_OK" = false ]; then
        # Check if port is already in use (a previous restart method might have worked)
        if command -v lsof &> /dev/null && lsof -ti:$SERVER_PORT &> /dev/null; then
            print_success "Server already listening on port $SERVER_PORT"
            return 0
        fi

        print_info "Fallback: stopping old process and starting directly..."
        # Stop any old process on the port
        if command -v pm2 &> /dev/null; then
            pm2 stop gmboop 2>/dev/null || true
        fi
        if command -v lsof &> /dev/null && lsof -ti:$SERVER_PORT &> /dev/null; then
            lsof -ti:$SERVER_PORT | xargs -r kill 2>/dev/null || true
            sleep 2
            if lsof -ti:$SERVER_PORT &> /dev/null; then
                lsof -ti:$SERVER_PORT | xargs -r kill -9 2>/dev/null || true
                sleep 1
            fi
        fi

        cd "$PROJECT_DIR"
        local SERVER_LOG="$PROJECT_DIR/logs/server-start.log"
        mkdir -p "$PROJECT_DIR/logs" 2>/dev/null || true
        echo "=== Server start at $(date) ===" > "$SERVER_LOG" 2>/dev/null || SERVER_LOG="/tmp/gmboop-server.log"

        NODE_BIN="$(which node 2>/dev/null)"
        if [ -z "$NODE_BIN" ]; then
            for p in /usr/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node/*/bin/node"; do
                if [ -x "$p" ]; then NODE_BIN="$p"; break; fi
            done
        fi
        if [ -z "$NODE_BIN" ]; then
            print_error "Node.js binary not found in PATH"
            return 1
        fi
        print_info "Using node: $NODE_BIN"
        setsid nohup "$NODE_BIN" server.js >> "$SERVER_LOG" 2>&1 &
        local SERVER_PID=$!
        sleep 5
        if kill -0 $SERVER_PID 2>/dev/null; then
            print_success "Server started directly (PID: $SERVER_PID)"
            RESTART_OK=true
        else
            print_error "Server failed to start directly"
            cat "$SERVER_LOG" 2>/dev/null || true
        fi
    fi

    [ "$RESTART_OK" = true ]
}

# ============================================================================
# Main Update Process
# ============================================================================

# Library mode stops here: helpers are defined, nothing has been touched.
if [ "$_GMBOOP_LIB_ONLY" = "1" ]; then
    return 0 2>/dev/null || exit 0
fi

trap _on_signal INT TERM

echo -e "${GREEN}"
cat << "EOF"
  __  __ _     _ _ __  __ _           _
 |  \/  (_) __| (_)  \/  (_)_ __   __| |
 | |\/| | |/ _` | | |\/| | | '_ \ / _` |
 | |  | | | (_| | | |  | | | | | | (_| |
 |_|  |_|_|\__,_|_|_|  |_|_|_| |_|\__,_|

         Update Script v2.0
EOF
echo -e "${NC}"

# Get current directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

cd "$PROJECT_DIR"

print_info "Project directory: $PROJECT_DIR"
_update_status "started"

# Detect server port from env (passed by Node backend), config.json, or default
if [ -z "$SERVER_PORT" ]; then
    if [ -f "$PROJECT_DIR/config.json" ] && command -v node &> /dev/null; then
        SERVER_PORT=$(node -p "try{JSON.parse(require('fs').readFileSync('$PROJECT_DIR/config.json','utf8')).server.port}catch(e){8080}" 2>/dev/null)
    fi
fi
SERVER_PORT="${SERVER_PORT:-8080}"

# Detect how the server is managed
PM2_AVAILABLE=false
PM2_MANAGED=false
SYSTEMD_MANAGED=false

if command -v pm2 &> /dev/null; then
    PM2_AVAILABLE=true
    if pm2 list 2>/dev/null | grep -q "gmboop"; then
        PM2_MANAGED=true
    fi
fi

if systemctl is-active --quiet gmboop 2>/dev/null; then
    SYSTEMD_MANAGED=true
fi

print_info "Server management: PM2_MANAGED=$PM2_MANAGED, SYSTEMD_MANAGED=$SYSTEMD_MANAGED, PM2_AVAILABLE=$PM2_AVAILABLE"
print_info "PM2_HOME=${PM2_HOME:-<unset>}, NVM_DIR=${NVM_DIR:-<unset>}"

# ============================================================================
# 1. Check Git Status
# ============================================================================

print_header "1. Restore Point & Git Status"

# Recover from a previous run that never finished, then make sure git is
# usable at all before touching anything.
_check_stale_restore_point
_clear_orphan_index_lock || true

# Nothing is modified before this succeeds: no restore point, no update.
if ! _create_restore_point; then
    abort_and_restart "Cannot create a restore point (is this a git checkout?)"
fi

# Check if we have uncommitted changes
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    print_warning "You have uncommitted changes!"
    git status --short
    # config.json is already saved in the restore point and is put back
    # right after the pull, so the stash below cannot eat it (F-121).
    if [ "$NON_INTERACTIVE" = "1" ]; then
        if git stash push -m "Auto-stash before update at $(date)"; then
            STASH_CREATED=true
            print_success "Changes auto-stashed (non-interactive mode) — config.json is restored automatically after the update"
        else
            print_warning "git stash failed — continuing with a dirty working tree"
        fi
    else
        read -p "Do you want to stash your changes? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            if git stash push -m "Auto-stash before update at $(date)"; then
                STASH_CREATED=true
            fi
            print_success "Changes stashed (config.json is restored automatically after the update)"
        else
            print_error "Please commit or stash your changes before updating"
            exit 1
        fi
    fi
fi

print_success "Working directory clean"

# Give the Node.js server time to send the response to the client
if [ "$NON_INTERACTIVE" = "1" ]; then
    DELAY=${UPDATE_DELAY_SECONDS:-3}
    print_info "Waiting ${DELAY}s for server response to complete..."
    sleep "$DELAY"
fi

# ============================================================================
# 2. Server stays running during update
# ============================================================================

print_header "2. Server Status"
print_info "Server stays running while files update on disk (new approach v2.0)"
print_info "This avoids the server being down during git pull + npm install"

# ============================================================================
# 3. Pull Latest Changes from GitHub
# ============================================================================

print_header "3. Pulling Latest Changes"
_update_status "pulling"

# Get current branch
CURRENT_BRANCH=$(git branch --show-current)
print_info "Current branch: $CURRENT_BRANCH"

# Determine target branch from UPDATE_TYPE env var
# stable (default) → always update from main
# beta             → stay on current branch and pull latest
UPDATE_TYPE="${UPDATE_TYPE:-stable}"
print_info "Update type: $UPDATE_TYPE"

if [ "$UPDATE_TYPE" = "beta" ] && [ -n "$CURRENT_BRANCH" ]; then
    TARGET_BRANCH="$CURRENT_BRANCH"
    print_info "Beta update: staying on branch '$TARGET_BRANCH'"
else
    if [ "$UPDATE_TYPE" = "beta" ] && [ -z "$CURRENT_BRANCH" ]; then
        print_warning "Detached HEAD detected, falling back to stable (main) update"
    fi
    TARGET_BRANCH="main"
    if [ "$CURRENT_BRANCH" != "main" ]; then
        print_warning "Not on main branch, switching to main..."
        if git checkout main; then
            print_success "Switched to main branch"
        else
            abort_and_restart "Failed to switch to main branch"
        fi
    else
        print_success "Already on main branch"
    fi
fi

# Fetch latest changes
print_info "Fetching from origin/$TARGET_BRANCH..."
git fetch origin "$TARGET_BRANCH" || true

# Pull changes
print_info "Pulling latest changes from $TARGET_BRANCH..."
if git pull origin "$TARGET_BRANCH"; then
    print_success "Successfully pulled latest changes from $TARGET_BRANCH"
else
    # Nothing after this point has run yet, but the pull itself may have left
    # the tree half-checked-out: go back to the restore point.
    _restore_config || true
    _critical_failure "failed to pull changes from $TARGET_BRANCH"
fi

# The pull (and the stash before it) took the operator's config.json with it.
# Put it back before anything reads it (audit F-121).
_restore_config || true

# Show what changed
echo ""
print_info "Recent commits:"
git log -5 --oneline --decorate 2>/dev/null || true

# ============================================================================
# 4. Update Dependencies
# ============================================================================

print_header "4. Updating Dependencies"
_update_status "installing"

# Always run npm install to ensure node_modules are present and up to date
print_info "Installing/updating npm dependencies..."
if npm install 2>&1; then
    print_success "Dependencies updated"
else
    print_warning "npm install had issues, trying --ignore-scripts fallback..."
    if npm install --ignore-scripts 2>&1; then
        npm rebuild better-sqlite3 2>&1 || print_warning "better-sqlite3 rebuild failed"
        print_success "Dependencies updated (fallback)"
    else
        # CRITICAL: new code on old dependencies means a missing import at
        # boot, i.e. a restart loop on a headless box (audit F-120).
        _critical_failure "npm install failed"
    fi
fi

# Rebuild the production SPA bundle so the server serves the updated, bundled
# UI from dist/ instead of falling back to the unbundled public/ tree (audit
# P1 — dist bundle never built). Best-effort: a build failure is not fatal.
# COSMETIC step: a failed build must never leave a half-written dist/ behind
# (the server only tests for dist/index.html), so the previous bundle is moved
# aside and put back on failure.
print_info "Building production web bundle..."
DIST_PREV=""
if [ -d "$PROJECT_DIR/dist" ]; then
    rm -rf "$PROJECT_DIR/dist.prev" 2>/dev/null || true
    if mv "$PROJECT_DIR/dist" "$PROJECT_DIR/dist.prev" 2>/dev/null; then
        DIST_PREV="$PROJECT_DIR/dist.prev"
    fi
fi
if NODE_ENV=production npm run build 2>&1; then
    print_success "Web bundle built (dist/)"
    if [ -n "$DIST_PREV" ]; then
        rm -rf "$DIST_PREV" 2>/dev/null || true
    fi
else
    print_warning "Web build failed (cosmetic step — update continues)"
    rm -rf "$PROJECT_DIR/dist" 2>/dev/null || true
    if [ -n "$DIST_PREV" ] && mv "$DIST_PREV" "$PROJECT_DIR/dist" 2>/dev/null; then
        print_warning "Previous web bundle restored — the UI stays on the old front-end"
    else
        print_warning "No previous bundle — the server falls back to the unbundled public/ assets"
    fi
fi

# ============================================================================
# 5. Run Database Migrations
# ============================================================================

print_header "5. Running Database Migrations"
_update_status "migrating"

if [ -f "scripts/migrate-db.js" ]; then
    # Migrations have no down-step: the snapshot taken here is the ONLY way
    # back if they fail half-way (audit F-120).
    _snapshot_database
    print_info "Running database migrations..."
    MIGRATIONS_RAN=true
    # stderr is NO LONGER discarded: a failing migration used to fail
    # invisibly, with its cause thrown away by `2>/dev/null`.
    if npm run migrate 2>&1; then
        print_success "Database migrations applied"
    else
        # CRITICAL: a partially migrated schema is exactly what makes an
        # installation unrecoverable without SSH.
        _critical_failure "database migration failed"
    fi
else
    print_info "No migration script found, skipping"
fi

# ============================================================================
# 6. Restart Server (single atomic restart)
# ============================================================================

print_header "6. Restarting Server"
_update_status "restarting"

cd "$PROJECT_DIR"
if ! _restart_server; then
    print_error "Server restart failed — attempting emergency recovery..."
    sleep 2
    if ! _restart_server; then
        # CRITICAL: the server does not come up on the new code.
        _critical_failure "server restart failed"
    fi
fi

# ============================================================================
# 7. Verify Update
# ============================================================================

print_header "7. Verification"
_update_status "verifying"

# Wait for server to fully start
print_info "Waiting for server to start..."
sleep 5

# Check PM2 status
if [ "$PM2_AVAILABLE" = true ]; then
    if pm2 list 2>/dev/null | grep -q "online.*gmboop"; then
        print_success "PM2 process is online"
    else
        print_warning "PM2 process may not be running correctly"
        pm2 list 2>/dev/null || true
    fi
fi

# Check if port is listening. "Not listening" and "no way to tell" are two
# different answers: only the first one is a reason to roll back, otherwise a
# minimal host without lsof/ss/netstat would revert every single update.
PORT_PROBE_AVAILABLE=false
if command -v lsof &> /dev/null || command -v ss &> /dev/null || command -v netstat &> /dev/null; then
    PORT_PROBE_AVAILABLE=true
fi

_port_listening() {
    if command -v lsof &> /dev/null; then
        lsof -ti:"$SERVER_PORT" &> /dev/null && return 0
        return 1
    elif command -v ss &> /dev/null; then
        ss -tln 2>/dev/null | grep -q ":$SERVER_PORT" && return 0
        return 1
    elif command -v netstat &> /dev/null; then
        netstat -tln 2>/dev/null | grep -q ":$SERVER_PORT" && return 0
        return 1
    fi
    return 1
}

SERVER_LISTENING=false
if [ "$PORT_PROBE_AVAILABLE" = true ] && _port_listening; then
    print_success "Server is listening on port $SERVER_PORT"
    SERVER_LISTENING=true
fi

if [ "$SERVER_LISTENING" = false ] && [ "$PORT_PROBE_AVAILABLE" = true ]; then
    print_warning "Server is not listening on port $SERVER_PORT"
    # Last resort: try one more restart before declaring the update failed.
    print_info "Attempting final restart..."
    _restart_server
    sleep 3
    if _port_listening; then
        print_success "Server is now listening on port $SERVER_PORT after final restart"
        SERVER_LISTENING=true
    else
        # CRITICAL: the update produced an installation that does not serve.
        _critical_failure "server is not listening on port $SERVER_PORT after the update"
    fi
elif [ "$SERVER_LISTENING" = false ]; then
    print_warning "No port probe available (lsof/ss/netstat) — cannot verify that the server came back up"
fi

# Test HTTP endpoint
if command -v curl &> /dev/null; then
    print_info "Testing HTTP endpoint..."
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$SERVER_PORT 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        print_success "HTTP endpoint responding correctly (HTTP $HTTP_CODE)"
    elif [ "$HTTP_CODE" = "000" ]; then
        print_warning "Could not connect to HTTP endpoint"
    else
        print_warning "HTTP endpoint returned: HTTP $HTTP_CODE"
    fi
fi

# Show current version
if [ -f "package.json" ]; then
    VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
    if [ -n "$VERSION" ]; then
        print_info "Current version: $VERSION"
    fi
fi

# Show database version
if [ -f "data/gmboop.db" ]; then
    print_info "Database exists: data/gmboop.db"
fi

# ============================================================================
# Summary
# ============================================================================

print_header "Update Complete"

# Every critical step passed: the restore point is no longer needed. The
# in-progress marker is dropped so the next run does not think this update
# died mid-flight; the pre-update database snapshots are pruned to the last
# three so backups/ does not grow forever.
_clear_restore_point
ls -1t "$PROJECT_DIR"/backups/pre-update-*.db 2>/dev/null | tail -n +4 | while read -r old_snapshot; do
    rm -f "$old_snapshot" "$old_snapshot-wal" "$old_snapshot-shm" 2>/dev/null || true
done

_update_status "done"

print_success "GeneralMidiBoop has been updated successfully!"
if [ -n "$DB_SNAPSHOT" ]; then
    print_info "Pre-update database snapshot kept: $(basename "$DB_SNAPSHOT")"
fi
echo ""
print_info "Access the interface at: http://localhost:$SERVER_PORT"
HOSTNAME_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$HOSTNAME_IP" ]; then
    print_info "Network access: http://${HOSTNAME_IP}:$SERVER_PORT"
fi
echo ""

# Check for stashed changes
if git stash list 2>/dev/null | grep -q "Auto-stash before update"; then
    print_warning "Local changes to tracked files were stashed. To restore them:"
    echo "  git stash pop"
    print_info "config.json is NOT in that stash's way: it was restored automatically."
fi

echo ""
print_info "Useful commands:"
echo "  npm run pm2:logs    # View PM2 logs"
echo "  npm run pm2:status  # Check PM2 status"
echo "  sudo systemctl status gmboop  # Check systemd status"
echo ""

exit 0
