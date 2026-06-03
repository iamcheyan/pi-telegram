#!/bin/bash
# Wrapper script for launching telegram-bridge with proper environment

# Source nvm if available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Set PATH to include node/npx
export PATH="$HOME/.nvm/versions/node/$(nvm current 2>/dev/null || echo 'v22.22.3')/bin:$PATH"

# Change to script directory
cd "$(dirname "$0")"

# Run the bridge
exec npx tsx telegram-bridge.ts
