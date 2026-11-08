@echo off
title Infrastruktur CMDB - stop
"%~dp0app\node\node.exe" "%~dp0app\launcher.mjs" --stop
timeout /t 3 >nul
