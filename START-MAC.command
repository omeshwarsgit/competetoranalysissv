#!/usr/bin/env bash
# Make sure we run from the project directory
cd "$(dirname "$0")" || exit 1

echo "====================================================================="
echo "               COMPETITOR PRICE ANALYZER - AUTO LAUNCHER            "
echo "====================================================================="
echo ""

# 1. Check if the dashboard is already running on port 3000
if lsof -t -i:3000 >/dev/null 2>&1; then
    echo "[*] Dashboard is ALREADY running on port 3000!"
    echo "[*] Opening in your web browser..."
    open "http://localhost:3000"
    sleep 2
    exit 0
fi

# 2. Check for Node.js (either portable local version or system installed)
NODE_OK=0
if [ -f "$PWD/.runtime/node/bin/node" ]; then
    export PATH="$PWD/.runtime/node/bin:$PATH"
    NODE_OK=1
    echo "[1/4] Portable Node.js runtime detected."
elif command -v node >/dev/null 2>&1; then
    NODE_OK=1
    echo "[1/4] System Node.js detected ($(node -v))."
fi

# If Node.js is missing, automatically download and configure standalone Node.js LTS
if [ "$NODE_OK" -eq 0 ]; then
    echo "[1/4] Node.js was not detected on this Mac."
    echo "      Downloading portable Node.js LTS runtime (no admin/sudo needed)..."

    ARCH=$(uname -m)
    if [ "$ARCH" = "arm64" ]; then
        NODE_URL="https://nodejs.org/dist/v20.18.0/node-v20.18.0-darwin-arm64.tar.gz"
        echo "      Detected Apple Silicon (M1/M2/M3/M4)..."
    else
        NODE_URL="https://nodejs.org/dist/v20.18.0/node-v20.18.0-darwin-x64.tar.gz"
        echo "      Detected Intel Mac..."
    fi

    mkdir -p ".runtime"
    TAR_PATH=".runtime/node.tar.gz"
    NODE_DIR=".runtime/node"

    echo "      [*] Downloading official Node.js package (~40MB)..."
    if ! curl -fSL --progress-bar -o "$TAR_PATH" "$NODE_URL"; then
        echo ""
        echo "[ERROR] Failed to download Node.js. Please check your internet connection."
        echo "Alternatively, install Node.js from https://nodejs.org/"
        read -p "Press Enter to exit..."
        exit 1
    fi

    echo "      [*] Extracting runtime files..."
    mkdir -p "$NODE_DIR"
    tar -xzf "$TAR_PATH" -C "$NODE_DIR" --strip-components=1
    rm -f "$TAR_PATH"

    export PATH="$PWD/.runtime/node/bin:$PATH"
    echo "      [OK] Portable Node.js ready!"
fi

# 3. Check and install project dependencies
if [ ! -d "node_modules" ]; then
    echo ""
    echo "[2/4] First-time setup: Installing required dependencies..."
    echo "      (This takes about 1 minute, please wait)..."
    if ! npm install --no-audit --no-fund; then
        echo ""
        echo "[ERROR] 'npm install' failed. Please check your internet connection."
        read -p "Press Enter to exit..."
        exit 1
    fi
    echo "      [OK] Dependencies installed successfully."
else
    echo "[2/4] Project dependencies are ready."
fi

# 4. Ensure Playwright browser engine is ready
echo ""
echo "[3/4] Checking browser automation components..."
npx playwright install chromium >/dev/null 2>&1
echo "      [OK] Browser engine ready."

# 5. Verify property config
if [ ! -f "config/properties.json" ]; then
    echo ""
    echo "[*] Initializing property configuration..."
    node import-properties.js
fi

# 6. Launch dashboard and open browser
echo ""
echo "====================================================================="
echo "[4/4] Everything is ready! Launching Competitor Price Analyzer..."
echo "      Your browser will open automatically at http://localhost:3000"
echo "====================================================================="
echo ""
echo "[NOTE] Keep this terminal window open while using the application."
echo "       To stop the application, press Ctrl+C or close this window."
echo ""

# Open default browser after 2 seconds
(sleep 2 && open "http://localhost:3000") &
node serve.js --no-open
