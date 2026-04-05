#!/bin/bash

# ============================================================================
# MidiMind Update Script
# Pulls latest changes from GitHub and updates the system
#
# Key design: the server stays RUNNING during git pull + npm install.
# Only a single atomic restart happens at the end. This avoids the server
# being down for minutes during npm install on slow devices (RPi).
# ============================================================================

# Non-interactive mode (called from web UI)
NON_INTERACTIVE="${NON_INTERACTIVE:-0}"
if [[ "$1" == "--non-interactive" ]]; then
    NON_INTERACTIVE=1
fi

# Log/status files — use project logs/ dir to avoid /tmp permission conflicts
SCRIPT_DIR_EARLY="$( cd "$( dirname "${BASH_SOURCE[0]}" )" 2>/dev/null && pwd )"
PROJECT_DIR_EARLY="$( cd "$SCRIPT_DIR_EARLY/.." 2>/dev/null && pwd )"
LOG_FILE="${PROJECT_DIR_EARLY}/logs/update.log"
STATUS_FILE="${PROJECT_DIR_EARLY}/logs/update-status"
mkdir -p "${PROJECT_DIR_EARLY}/logs" 2>/dev/null || true

# Immediate startup marker - BEFORE any redirect, so we know bash started
echo "$(date '+%Y-%m-%d %H:%M:%S') script_started pid=$$ non_interactive=$NON_INTERACTIVE" > "$STATUS_FILE" 2>/dev/null

# Double-fork: escape the parent process tree so PM2 treekill cannot reach us.
# PM2 kills all descendants by PPID when stopping a process.  Even with
# detached:true (setsid) from Node.js, our PPID still points to the server
# while it is alive.  Re-executing via setsid & exit makes the new instance
# an orphan (PPID=1) that PM2 cannot find.
# Only detach in non-interactive mode (web UI) — in SSH, run directly so the
# user can see output in the terminal.
if [ "$NON_INTERACTIVE" = "1" ] && [ -z "$_MIDIMIND_UPDATE_DETACHED" ]; then
    export _MIDIMIND_UPDATE_DETACHED=1
    setsid "$0" "$@" &
    exit 0
fi

if [ "$NON_INTERACTIVE" = "1" ]; then
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

# Restart server helper — simple version with one fallback per method
_restart_server() {
    local RESTART_OK=false

    if [ "$PM2_MANAGED" = true ]; then
        print_info "Restarting with PM2 (atomic restart)..."
        if pm2 restart midimind --update-env 2>&1; then
            sleep 3
            if pm2 list | grep -q "online.*midimind"; then
                RESTART_OK=true
                print_success "PM2 restart successful"
            fi
        fi
        # Fallback: delete + start from ecosystem file
        if [ "$RESTART_OK" = false ]; then
            print_warning "PM2 restart failed, trying delete + start..."
            pm2 delete midimind 2>/dev/null || true
            sleep 1
            if pm2 start ecosystem.config.cjs 2>&1; then
                pm2 save 2>/dev/null || true
                sleep 5
                if pm2 list | grep -q "online.*midimind"; then
                    RESTART_OK=true
                    print_success "PM2 delete+start successful"
                else
                    print_warning "PM2 process not online after start"
                    pm2 list || true
                    pm2 logs midimind --lines 20 --nostream 2>/dev/null || true
                fi
            fi
        fi
    elif [ "$SYSTEMD_MANAGED" = true ]; then
        print_info "Restarting with systemd..."
        if timeout 10 sudo -n systemctl restart midimind 2>/dev/null; then
            sleep 3
            if systemctl is-active --quiet midimind 2>/dev/null; then
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
        pm2 delete midimind 2>/dev/null || true
        sleep 1
        if pm2 start ecosystem.config.cjs 2>&1; then
            pm2 save 2>/dev/null || true
            sleep 5
            if pm2 list | grep -q "online.*midimind"; then
                RESTART_OK=true
                print_success "PM2 start successful"
            else
                print_warning "PM2 start may have failed"
                pm2 list || true
                pm2 logs midimind --lines 20 --nostream 2>/dev/null || true
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
            pm2 stop midimind 2>/dev/null || true
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
        echo "=== Server start at $(date) ===" > "$SERVER_LOG" 2>/dev/null || SERVER_LOG="/tmp/midimind-server.log"

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
    if pm2 list 2>/dev/null | grep -q "midimind"; then
        PM2_MANAGED=true
    fi
fi

if systemctl is-active --quiet midimind 2>/dev/null; then
    SYSTEMD_MANAGED=true
fi

print_info "Server management: PM2_MANAGED=$PM2_MANAGED, SYSTEMD_MANAGED=$SYSTEMD_MANAGED, PM2_AVAILABLE=$PM2_AVAILABLE"
print_info "PM2_HOME=${PM2_HOME:-<unset>}, NVM_DIR=${NVM_DIR:-<unset>}"

# ============================================================================
# 1. Check Git Status
# ============================================================================

print_header "1. Checking Git Status"

# Check if we have uncommitted changes
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    print_warning "You have uncommitted changes!"
    git status --short
    if [ "$NON_INTERACTIVE" = "1" ]; then
        git stash push -m "Auto-stash before update at $(date)" || true
        print_success "Changes auto-stashed (non-interactive mode)"
    else
        read -p "Do you want to stash your changes? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            git stash push -m "Auto-stash before update at $(date)"
            print_success "Changes stashed"
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

# Switch to main if not already on it
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

# Fetch latest changes
print_info "Fetching from origin/main..."
git fetch origin main || true

# Pull changes from main
print_info "Pulling latest changes from main..."
if git pull origin main; then
    print_success "Successfully pulled latest changes from main"
else
    abort_and_restart "Failed to pull changes from main"
fi

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
        npm rebuild better-sqlite3 2>/dev/null || true
        print_success "Dependencies updated (fallback)"
    else
        abort_and_restart "npm install failed completely"
    fi
fi

# ============================================================================
# 5. Run Database Migrations
# ============================================================================

print_header "5. Running Database Migrations"

if [ -f "scripts/migrate-db.js" ]; then
    print_info "Running database migrations..."
    npm run migrate 2>/dev/null || print_warning "Migration had issues (may be OK if no changes needed)"
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
    _restart_server || print_error "Emergency recovery also failed. Manual intervention required."
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
    if pm2 list 2>/dev/null | grep -q "online.*midimind"; then
        print_success "PM2 process is online"
    else
        print_warning "PM2 process may not be running correctly"
        pm2 list 2>/dev/null || true
    fi
fi

# Check if port is listening
SERVER_LISTENING=false
if command -v lsof &> /dev/null; then
    if lsof -ti:$SERVER_PORT &> /dev/null; then
        print_success "Server is listening on port $SERVER_PORT"
        SERVER_LISTENING=true
    fi
elif command -v ss &> /dev/null; then
    if ss -tlnp 2>/dev/null | grep -q ":$SERVER_PORT"; then
        print_success "Server is listening on port $SERVER_PORT"
        SERVER_LISTENING=true
    fi
elif command -v netstat &> /dev/null; then
    if netstat -tlnp 2>/dev/null | grep -q ":$SERVER_PORT"; then
        print_success "Server is listening on port $SERVER_PORT"
        SERVER_LISTENING=true
    fi
fi

if [ "$SERVER_LISTENING" = false ]; then
    print_warning "Could not verify server is listening on port $SERVER_PORT"
    # Last resort: try one more restart
    print_info "Attempting final restart..."
    _restart_server
    sleep 3
    if command -v lsof &> /dev/null && lsof -ti:$SERVER_PORT &> /dev/null; then
        print_success "Server is now listening on port $SERVER_PORT after final restart"
        SERVER_LISTENING=true
    fi
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
if [ -f "data/midimind.db" ]; then
    print_info "Database exists: data/midimind.db"
fi

# ============================================================================
# Summary
# ============================================================================

print_header "Update Complete"
_update_status "done"

print_success "MidiMind has been updated successfully!"
echo ""
print_info "Access the interface at: http://localhost:$SERVER_PORT"
HOSTNAME_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$HOSTNAME_IP" ]; then
    print_info "Network access: http://${HOSTNAME_IP}:$SERVER_PORT"
fi
echo ""

# Check for stashed changes
if git stash list 2>/dev/null | grep -q "Auto-stash before update"; then
    print_warning "You have stashed changes. To restore them:"
    echo "  git stash pop"
fi

echo ""
print_info "Useful commands:"
echo "  npm run pm2:logs    # View PM2 logs"
echo "  npm run pm2:status  # Check PM2 status"
echo "  sudo systemctl status midimind  # Check systemd status"
echo ""

exit 0
