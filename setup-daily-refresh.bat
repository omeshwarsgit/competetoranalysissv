@echo off
:: setup-daily-refresh.bat — Register a Windows Task Scheduler job that scrapes PRICES
:: every day at 6:00 AM, four hours after setup-daily-scan.bat refreshes the competitor set.
:: Run this file ONCE (as Administrator if Task Scheduler requires it).

setlocal
set TASK_NAME=StayVista Daily Price Refresh
set WRAPPER=%~dp0run-scheduled-refresh.cmd
set LOG=%~dp0data\refresh-stdout.log

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
  /ST 06:00 ^
  /F

if %ERRORLEVEL% == 0 (
  echo.
  echo [OK] Task "%TASK_NAME%" scheduled daily at 06:00 AM.
  echo      Runs: %WRAPPER%
  echo      Log:  %LOG%
  echo.
  echo NOTE: this scrapes Booking.com through your real Chrome profile. It works
  echo       unattended while that Booking.com session stays valid; if it expires the
  echo       task exits with a failure and that day is skipped. Log in again and re-run:
  echo         schtasks /Run /TN "%TASK_NAME%"
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
