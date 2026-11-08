@echo off
setlocal
title Infrastruktur CMDB
cd /d "%~dp0"
if not exist "%~dp0app\node\node.exe" (
  echo Please unpack the complete ZIP file first ^(right-click - Extract All^), then start "Start CMDB.cmd" from the unpacked folder.
  pause
  exit /b 1
)
"%~dp0app\node\node.exe" "%~dp0app\launcher.mjs" %*
if errorlevel 1 (
  echo.
  echo Something went wrong - see the messages above.
  pause
)
