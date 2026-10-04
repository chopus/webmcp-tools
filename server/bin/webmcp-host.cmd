@echo off
rem webmcp-browser native messaging host launcher (Windows).
rem Chrome executes this via cmd.exe; it re-launches the built relay with
rem --native-host and propagates the exit code. Survives spaces in paths.
rem Chrome may launch hosts with a minimal PATH; resolve node explicitly
rem when it is not on it (mirrors webmcp-host.sh fallbacks).
setlocal
set "SCRIPT_DIR=%~dp0"
set "NODE_BIN="
where node >nul 2>nul
if not errorlevel 1 for /f "delims=" %%i in ('where node') do (
  if not defined NODE_BIN set "NODE_BIN=%%i"
)
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_BIN (
  echo webmcp-host: node not found in PATH or fallback locations 1>&2
  exit /b 1
)
"%NODE_BIN%" "%SCRIPT_DIR%..\dist\index.js" --native-host
exit /b %ERRORLEVEL%
