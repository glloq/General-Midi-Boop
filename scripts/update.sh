#!/bin/bash

# ============================================================================
# MidiMind Update Script
# Pulls latest changes from GitHub and updates the system
# ============================================================================

# Non-interactive mode (called from web UI)
NON_INTERACTIVE="${NON_INTERACTIVE:-0}"
if [[ "$1" == "--non-interactive" ]]; then
    NON_INTERACTIVE=1
fi

# Log file for non-interactive debugging
LOG_FILE="/tmp/midimind-update.log"
if [ "$NON_INTERACTIVE" = "1" ]; then
    exec > "$LOG_FILE" 2>&1
fi

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

# Abort update and attempt to restart the server
abort_and_restart() {
    print_error "Update aborted: $1"
    print_header "Restarting Server (recovery)"
    if [ "$PM2_MANAGED" = true ]; then
        pm2 restart midimind 2>/dev/null || pm2 start ecosystem.config.cjs 2>/dev/null || true
    elif [ "$SYSTEMD_MANAGED" = true ]; then
        timeout 10 sudo -n systemctl start midimind 2>/dev/null || true
    elif [ "$PM2_AVAILABLE" = true ]; then
        pm2 start ecosystem.config.cjs 2>/dev/null || true
    else
        cd "$PROJECT_DIR"
        nohup node server.js >> /tmp/midimind-server.log 2>&1 &
    fi
    exit 1
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

         Update Script v1.1
EOF
echo -e "${NC}"

# Get current directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

cd "$PROJECT_DIR"

print_info "Project directory: $PROJECT_DIR"

# Detect server port from env (passed by Node backend), config.json, or default
if [ -z "$SERVER_PORT" ]; then
    if [ -f "$PROJECT_DIR/config.json" ] && command -v node &> /dev/null; then
        SERVER_PORT=$(node -p "try{JSON.parse(require('fs').readFileSync('$PROJECT_DIR/config.json','utf8')).server.port}catch(e){8080}" 2>/dev/null)
    fi
fi
SERVER_PORT="${SERVER_PORT:-8080}"

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
# 2. Stop Running Server
# ============================================================================

print_header "2. Stopping Server"

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

# Stop the server
if [ "$PM2_MANAGED" = true ]; then
    print_info "Stopping PM2 process (will restart after update)..."
    pm2 stop midimind 2>/dev/null || true
    print_success "PM2 process stopped"
elif [ "$SYSTEMD_MANAGED" = true ]; then
    print_info "Stopping systemd service..."
    timeout 10 sudo -n systemctl stop midimind 2>/dev/null || true
    print_success "Systemd service stopped"
else
    # Direct node process - kill it
    print_info "Stopping server process..."
    # Try multiple methods to find and kill the server process
    if command -v lsof &> /dev/null && lsof -ti:$SERVER_PORT &> /dev/null; then
        lsof -ti:$SERVER_PORT | xargs -r kill 2>/dev/null || true
        sleep 2
        # Force kill if still running
        if lsof -ti:$SERVER_PORT &> /dev/null; then
            lsof -ti:$SERVER_PORT | xargs -r kill -9 2>/dev/null || true
            sleep 1
        fi
        print_success "Server stopped"
    elif command -v fuser &> /dev/null && fuser $SERVER_PORT/tcp &> /dev/null; then
        fuser -k $SERVER_PORT/tcp 2>/dev/null || true
        sleep 2
        print_success "Server stopped"
    else
        # Fallback: kill by process name
        pkill -f "node $PROJECT_DIR/server.js" 2>/dev/null || pkill -f "node.*server.js" 2>/dev/null || true
        sleep 2
        print_info "Attempted to stop server via pkill"
    fi
fi

# ============================================================================
# 3. Pull Latest Changes from GitHub
# ============================================================================

print_header "3. Pulling Latest Changes"

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
# 6. Restart Server (CRITICAL - must always execute)
# ============================================================================

print_header "6. Restarting Server"

# Restart using the same method that was running before
if [ "$PM2_MANAGED" = true ]; then
    print_info "Restarting with PM2..."
    pm2 restart midimind 2>/dev/null || pm2 start ecosystem.config.cjs 2>/dev/null || true
    pm2 save 2>/dev/null || true
    sleep 3
    print_success "PM2 process restarted"
    pm2 list 2>/dev/null || true

elif [ "$SYSTEMD_MANAGED" = true ]; then
    print_info "Restarting with systemd..."
    timeout 10 sudo -n systemctl start midimind 2>/dev/null || true
    sleep 2
    print_success "Systemd service restarted"

elif [ "$PM2_AVAILABLE" = true ]; then
    print_info "Starting with PM2..."
    pm2 start ecosystem.config.cjs 2>/dev/null || true
    pm2 save 2>/dev/null || true
    sleep 3
    print_success "Server started with PM2"

else
    # Fallback: start node directly in background
    print_info "Starting server directly..."
    cd "$PROJECT_DIR"
    nohup node server.js >> /tmp/midimind-server.log 2>&1 &
    SERVER_PID=$!
    sleep 3
    if kill -0 $SERVER_PID 2>/dev/null; then
        print_success "Server started (PID: $SERVER_PID)"
    else
        print_error "Server failed to start, check /tmp/midimind-server.log"
        # Try one more time
        print_info "Retrying server start..."
        nohup node server.js >> /tmp/midimind-server.log 2>&1 &
        SERVER_PID=$!
        sleep 5
        if kill -0 $SERVER_PID 2>/dev/null; then
            print_success "Server started on retry (PID: $SERVER_PID)"
        else
            print_error "Server failed to start after retry"
        fi
    fi
fi

# ============================================================================
# 7. Verify Update
# ============================================================================

print_header "7. Verification"

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
