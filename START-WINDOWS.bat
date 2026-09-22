@echo off
setlocal enabledelayedexpansion
title Competitor Price Analyzer
cd /d "%~dp0"

echo =====================================================================
echo                COMPETITOR PRICE ANALYZER - AUTO LAUNCHER            
echo =====================================================================
echo.

:: 1. Check if the dashboard server is already running on port 3000
netstat -ano | findstr ":3000.*LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [*] Dashboard is ALREADY running on port 3000!
    echo [*] Opening in your web browser...
    start "" "http://localhost:3000"
    timeout /t 3 >nul
    exit /b 0
)

:: 2. Check for Node.js (either portable local version or system installed)
set "NODE_OK=0"
if exist "%~dp0.runtime\node\node.exe" (
    set "PATH=%~dp0.runtime\node;%PATH%"
    set "NODE_OK=1"
    echo [1/4] Portable Node.js runtime detected.
) else (
    where node >nul 2>&1
    if %ERRORLEVEL% equ 0 (
        set "NODE_OK=1"
        for /f "tokens=*" %%v in ('node -v 2^>nul') do echo [1/4] System Node.js detected (%%v^).
    )
)

:: If Node.js is missing, automatically download and configure portable Node.js LTS
if "!NODE_OK!"=="0" (
    echo [1/4] Node.js was not detected on this system.
    echo       Downloading portable Node.js LTS runtime (no admin rights needed^)...
    
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "& { param($runtimeDir); " ^
        "  $ErrorActionPreference = 'Stop'; " ^
        "  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
        "  if (-not (Test-Path $runtimeDir)) { New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null }; " ^
        "  $zipPath = Join-Path $runtimeDir 'node.zip'; " ^
        "  $extractDir = Join-Path $runtimeDir 'temp_node'; " ^
        "  $finalDir = Join-Path $runtimeDir 'node'; " ^
        "  Write-Host '  [*] Downloading official Node.js package (~30MB)...' -ForegroundColor Cyan; " ^
        "  Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.18.0/node-v20.18.0-win-x64.zip' -OutFile $zipPath; " ^
        "  Write-Host '  [*] Extracting files...' -ForegroundColor Cyan; " ^
        "  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force; " ^
        "  $unzipped = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1; " ^
        "  if (Test-Path $finalDir) { Remove-Item -Path $finalDir -Recurse -Force }; " ^
        "  Move-Item -Path $unzipped.FullName -Destination $finalDir -Force; " ^
        "  Remove-Item -Path $extractDir -Recurse -Force -ErrorAction SilentlyContinue; " ^
        "  Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue; " ^
        "  Write-Host '  [OK] Portable Node.js ready!' -ForegroundColor Green; " ^
        "}" -runtimeDir "%~dp0.runtime"

    if not exist "%~dp0.runtime\node\node.exe" (
        echo.
        echo [ERROR] Could not automatically download Node.js.
        echo Please ensure you are connected to the internet, or install Node.js from https://nodejs.org/
        echo.
        pause
        exit /b 1
    )
    set "PATH=%~dp0.runtime\node;%PATH%"
)

:: 3. Check and install project dependencies
if not exist "%~dp0node_modules\" (
    echo.
    echo [2/4] First-time setup: Installing required dependencies...
    echo       (This takes about 1 minute, please wait^)...
    call npm install --no-audit --no-fund
    if %ERRORLEVEL% neq 0 (
        echo.
        echo [ERROR] 'npm install' failed. Please check your internet connection.
        pause
        exit /b 1
    )
    echo       [OK] Dependencies installed successfully.
) else (
    echo [2/4] Project dependencies are ready.
)

:: 4. Ensure Playwright browser engine is ready
echo.
echo [3/4] Checking browser automation components...
call npx playwright install chromium >nul 2>&1
echo       [OK] Browser engine ready.

:: 5. Verify property config
if not exist "%~dp0config\properties.json" (
    echo.
    echo [*] Initializing property configuration...
    call node import-properties.js
)

:: 6. Launch dashboard and open browser
echo.
echo =====================================================================
echo [4/4] Everything is ready! Launching Competitor Price Analyzer...
echo       Your browser will open automatically at http://localhost:3000
echo =====================================================================
echo.
echo [NOTE] Keep this window open while using the application.
echo        To stop the application, simply close this window.
echo.

:: Open default browser after a brief moment
start "" "http://localhost:3000"
node serve.js --no-open

pause
