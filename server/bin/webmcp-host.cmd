@echo off
rem webmcp-browser native messaging host launcher (Windows).
rem Chrome executes this via cmd.exe; it re-launches the built relay with
rem --native-host and propagates the exit code. Survives spaces in paths.
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%..\dist\index.js" --native-host
exit /b %ERRORLEVEL%
