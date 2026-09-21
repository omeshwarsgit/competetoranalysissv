@echo off
:: run-scheduled-scan.cmd — what the Task Scheduler entry actually executes.
::
:: The redirection has to live in a wrapper like this. Task Scheduler launches the program
:: directly rather than through a shell, so a ">> log 2>&1" written into schtasks /TR is handed
:: to node.exe as three more argv entries and no log is ever written.
setlocal
cd /d "%~dp0"

set NODE_EXE=
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set NODE_EXE=%%I
if not defined NODE_EXE set NODE_EXE=C:\Program Files\nodejs\node.exe

if not exist "data" mkdir "data"
"%NODE_EXE%" "%~dp0scheduled-scan.js" %* >> "%~dp0data\scan-stdout.log" 2>&1
exit /b %ERRORLEVEL%
