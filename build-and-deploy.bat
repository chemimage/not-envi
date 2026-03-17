@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "DIST_DIR=%SCRIPT_DIR%dist"
set "TARGET_DIR=%~1"

if not defined TARGET_DIR set "TARGET_DIR=C:\nginx\web"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found in PATH.
  exit /b 1
)

where robocopy >nul 2>nul
if errorlevel 1 (
  echo robocopy was not found in PATH.
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

if not exist "%TARGET_DIR%" (
  mkdir "%TARGET_DIR%"
  if errorlevel 1 (
    echo Failed to create target directory "%TARGET_DIR%".
    exit /b 1
  )
)

robocopy "%DIST_DIR%" "%TARGET_DIR%" /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
set "ROBOCOPY_EXIT=%ERRORLEVEL%"

if %ROBOCOPY_EXIT% GEQ 8 (
  echo Deploy copy failed with robocopy exit code %ROBOCOPY_EXIT%.
  exit /b %ROBOCOPY_EXIT%
)

echo Deployed "%DIST_DIR%" to "%TARGET_DIR%".
exit /b 0
