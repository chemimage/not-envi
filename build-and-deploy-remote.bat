@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "DIST_DIR=%SCRIPT_DIR%dist"
set "REMOTE_HOST=inference"
set "REMOTE_DIR=/srv/www/hyve"
set "REMOTE_TMP=/tmp/hyve_dist"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found in PATH.
  exit /b 1
)

where scp >nul 2>nul
if errorlevel 1 (
  echo scp was not found in PATH.
  exit /b 1
)

where ssh >nul 2>nul
if errorlevel 1 (
  echo ssh was not found in PATH.
  exit /b 1
)

pushd "%SCRIPT_DIR%" >nul
call npm run build
set "BUILD_EXIT=%ERRORLEVEL%"
popd >nul

if not "%BUILD_EXIT%"=="0" (
  echo Build failed with exit code %BUILD_EXIT%.
  exit /b %BUILD_EXIT%
)

if not exist "%DIST_DIR%\index.html" (
  echo Build output not found: "%DIST_DIR%\index.html"
  exit /b 1
)

echo Preparing remote temp directory...
ssh %REMOTE_HOST% "rm -rf %REMOTE_TMP% && mkdir -p %REMOTE_TMP%"
if errorlevel 1 (
  echo Failed to prepare remote temp directory.
  exit /b 1
)

echo Copying build output to %REMOTE_HOST%...
scp -r "%DIST_DIR%\*" %REMOTE_HOST%:%REMOTE_TMP%/
if errorlevel 1 (
  echo Failed to copy build output to remote host.
  exit /b 1
)

echo Installing build into %REMOTE_DIR%...
ssh -t %REMOTE_HOST% "sudo mkdir -p %REMOTE_DIR% && sudo rm -rf %REMOTE_DIR%/* && sudo cp -r %REMOTE_TMP%/* %REMOTE_DIR%/ && sudo chown -R root:www-data %REMOTE_DIR% && sudo find %REMOTE_DIR% -type d -exec chmod 755 {} \; && sudo find %REMOTE_DIR% -type f -exec chmod 644 {} \; && rm -rf %REMOTE_TMP%"
if errorlevel 1 (
  echo Remote deploy failed.
  exit /b 1
)

echo Deployed "%DIST_DIR%" to "%REMOTE_HOST%:%REMOTE_DIR%".
exit /b 0