#!/bin/bash

# ============================================================================
# MidiMind Update Script
# Pulls latest changes from GitHub and updates the system
# ============================================================================

set -e  # Exit on error

# Non-interactive mode (called from web UI)
NON_INTERACTIVE="${NON_INTERACTIVE:-0}"
if [[ "$1" == "--non-interactive" ]]; then
    NON_INTERACTIVE=1
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

         Update Script v1.0
EOF
echo -e "${NC}"

# Get current directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

cd "$PROJECT_DIR"

print_info "Project directory: $PROJECT_DIR"

# ============================================================================
# 1. Check Git Status
# ============================================================================

print_header "1. Checking Git Status"

# Check if we have uncommitted changes
if ! git diff-index --quiet HEAD --; then
    print_warning "You have uncommitted changes!"
    git status --short
    if [ "$NON_INTERACTIVE" = "1" ]; then
        git stash push -m "Auto-stash before update at $(date)"
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

# ============================================================================
# 2. Stop Running Server
# ============================================================================

print_header "2. Stopping Server"

# Check if PM2 is available
PM2_AVAILABLE=false
if command -v pm2 &> /dev/null; then
    PM2_AVAILABLE=true
fi

# Stop PM2 process completely (delete, not just stop)
if [ "$PM2_AVAILABLE" = true ]; then
    if pm2 list | grep -q "midimind"; then
        print_info "Stopping and removing PM2 process..."
        pm2 delete midimind 2>/dev/null || true
        print_success "PM2 process removed"
    else
        print_info "No PM2 process running"
    fi
fi

# Try systemd
if systemctl is-active --quiet midimind 2>/dev/null; then
    print_info "Stopping systemd service..."
    sudo systemctl stop midimind
    print_success "Systemd service stopped"
fi

# Kill any remaining node processes on port 8080
if lsof -ti:8080 &> /dev/null; then
    print_info "Killing processes on port 8080..."
    lsof -ti:8080 | xargs -r kill -9 2>/dev/null || true
    sleep 2
    print_success "Port 8080 freed"
else
    print_info "Port 8080 already free"
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
        print_error "Failed to switch to main branch"
        print_info "You may need to commit or stash changes first"
        exit 1
    fi
else
    print_success "Already on main branch"
fi

# Fetch latest changes
print_info "Fetching from origin/main..."
git fetch origin main

# Pull changes from main
print_info "Pulling latest changes from main..."
if git pull origin main; then
    print_success "Successfully pulled latest changes from main"
else
    print_error "Failed to pull changes from main"
    exit 1
fi

# Show what changed
echo ""
print_info "Recent commits:"
git log -5 --oneline --decorate

# ============================================================================
# 4. Update Dependencies
# ============================================================================

print_header "4. Updating Dependencies"

# Check if package.json changed
if git diff HEAD@{1} --name-only | grep -q "package.json"; then
    print_info "package.json changed, updating npm dependencies..."
    npm install
    print_success "Dependencies updated"
else
    print_info "No package.json changes detected, skipping npm install"
fi

# ============================================================================
# 5. Run Database Migrations
# ============================================================================

print_header "5. Running Database Migrations"

# Check if migrations directory changed
if git diff HEAD@{1} --name-only | grep -q "migrations/"; then
    print_info "Migrations changed, running database migrations..."
    npm run migrate
    print_success "Database migrations completed"
else
    print_info "No migration changes detected"
    # Run migrations anyway to be safe
    npm run migrate
fi

# ============================================================================
# 6. Restart Server
# ============================================================================

print_header "6. Restarting Server"

# Choose restart method based on what was running before
if [ "$PM2_AVAILABLE" = true ]; then
    print_info "Starting with PM2..."

    # Start fresh with ecosystem.config.cjs
    if pm2 start ecosystem.config.cjs; then
        print_success "PM2 process started"

        # Save PM2 configuration
        pm2 save
        print_success "PM2 configuration saved"

        # Wait for server to be ready
        sleep 3

        # Show status
        print_info "PM2 Status:"
        pm2 list

        # Show logs
        echo ""
        print_info "Recent logs:"
        pm2 logs midimind --lines 15 --nostream

    else
        print_error "Failed to start PM2 process"
        print_info "Check ecosystem.config.cjs for errors"
        exit 1
    fi

elif systemctl list-units --type=service | grep -q "midimind"; then
    print_info "Restarting with systemd..."
    sudo systemctl restart midimind
    sleep 2
    if systemctl is-active --quiet midimind; then
        print_success "Systemd service restarted"

        # Show status
        print_info "Service status:"
        sudo systemctl status midimind --no-pager -l
    else
        print_error "Failed to restart systemd service"
        sudo systemctl status midimind --no-pager -l
        exit 1
    fi
else
    print_warning "No service manager detected"
    print_info "Starting server with PM2..."

    if [ "$PM2_AVAILABLE" = true ]; then
        pm2 start ecosystem.config.cjs
        pm2 save
        print_success "Server started with PM2"
    else
        print_warning "PM2 not available"
        print_info "You can start the server manually with:"
        echo "  npm start          # Foreground"
        echo "  npm run pm2:start  # Background with PM2"
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
    if pm2 list | grep -q "online.*midimind"; then
        print_success "PM2 process is online"
    else
        print_warning "PM2 process may not be running correctly"
        pm2 list
    fi
fi

# Check if port 8080 is listening
if lsof -ti:8080 &> /dev/null; then
    print_success "Server is listening on port 8080"
else
    print_error "Server is NOT listening on port 8080"
    if [ "$PM2_AVAILABLE" = true ]; then
        print_info "Checking PM2 logs for errors..."
        pm2 logs midimind --lines 20 --nostream
    fi
fi

# Test HTTP endpoint
print_info "Testing HTTP endpoint..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then
    print_success "HTTP endpoint responding correctly (HTTP $HTTP_CODE)"
else
    print_warning "HTTP endpoint returned: HTTP $HTTP_CODE"
fi

# Show current version
if [ -f "package.json" ]; then
    VERSION=$(node -p "require('./package.json').version" 2>/dev/null)
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
print_info "Access the interface at: http://localhost:8080"
print_info "Network access: http://$(hostname -I | awk '{print $1}'):8080"
echo ""

# Check for stashed changes
if git stash list | grep -q "Auto-stash before update"; then
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
