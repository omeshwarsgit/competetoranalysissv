@echo off
cd /d "%~dp0"
echo.
echo  Step 1 — Importing properties from properties.csv ...
echo.
node import-properties.js
if %errorlevel% neq 0 (
  echo.
  echo  Import failed. Fix the errors above and try again.
  pause
  exit /b 1
)
echo.
echo  Step 2 — Scraping fresh prices from Booking.com ...
echo  (This takes ~2 minutes. Chrome will open automatically.)
echo.
node refresh.js
if %errorlevel% neq 0 (
  echo.
  echo  Scrape failed. See error above.
  pause
  exit /b 1
)
echo.
echo  All done! Opening dashboard...
echo.
node serve.js
