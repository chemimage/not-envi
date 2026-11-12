@echo off
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required.
  exit /b 1
)

node "%~dp0scripts\deploy-remote.mjs" %*
exit /b %ERRORLEVEL%
