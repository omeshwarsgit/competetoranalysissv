@echo off
:: setup-daily-scan.bat — Register a Windows Task Scheduler job that runs
:: scheduled-scan.js (competitor DISCOVERY) every day at 2:00 AM.
:: For the price scrape, run setup-daily-refresh.bat as well.
:: Run this file ONCE (as Administrator if Task Scheduler requires it).

setlocal
set TASK_NAME=StayVista Daily Competitor Scan
set WRAPPER=%~dp0run-scheduled-scan.cmd
set LOG=%~dp0data\scan-stdout.log

if not exist "%WRAPPER%" (
  echo [ERROR] Missing %WRAPPER%
  pause
  exit /b 1
)

:: Delete existing task if it exists (idempotent)
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1

:: Point the task at the wrapper. Node resolution and log redirection live in there —
:: schtasks /TR does not go through a shell, so ">>" written here would not redirect.
schtasks /Create ^
  /TN "%TASK_NAME%" ^
  /TR "\"%WRAPPER%\"" ^
  /SC DAILY ^
  /ST 02:00 ^
  /F

if %ERRORLEVEL% == 0 (
  echo.
  echo [OK] Task "%TASK_NAME%" scheduled daily at 02:00 AM.
  echo      Runs: %WRAPPER%
  echo      Log:  %LOG%
  echo.
  echo To run manually now:
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
endlocal
