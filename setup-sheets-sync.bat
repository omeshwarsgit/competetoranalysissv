@echo off
:: setup-sheets-sync.bat — Register a Windows Task Scheduler job that keeps the
:: Google Sheet in sync with the scraped pricing data.
::
:: Runs sync-sheets.js in --watch mode at logon: it syncs on startup, then again
:: every time data/latest.dashboard.json changes (i.e. whenever refresh.js writes
:: new prices), plus on the interval in config/sheets.json.
::
:: Run this file ONCE (as Administrator if Task Scheduler requires it).
:: Prerequisite: complete SHEETS-SETUP.md first, then verify with
::   node sync-sheets.js --dry-run

set TASK_NAME=Competitor Price Analyzer - Sheets Sync
set NODE_EXE="C:\Program Files\nodejs\node.exe"
set SCRIPT="%~dp0sync-sheets.js"
set LOG="%~dp0data\sheets-sync.log"

:: Delete existing task if it exists (idempotent)
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1

schtasks /Create ^
  /TN "%TASK_NAME%" ^
  /TR "%NODE_EXE% %SCRIPT% --watch >> %LOG% 2>&1" ^
  /SC ONLOGON ^
  /RL LIMITED ^
  /F

if %ERRORLEVEL% == 0 (
  echo.
  echo [OK] Task "%TASK_NAME%" registered to start at logon in watch mode.
  echo      Node: %NODE_EXE%
  echo      Script: %SCRIPT%
  echo      Log: %LOG%
  echo.
  echo To start it now without logging off:
  echo   schtasks /Run /TN "%TASK_NAME%"
  echo.
  echo To remove the task:
  echo   schtasks /Delete /TN "%TASK_NAME%" /F
) else (
  echo.
  echo [ERROR] Could not create scheduled task.
  echo         Try running this file as Administrator.
)
pause
