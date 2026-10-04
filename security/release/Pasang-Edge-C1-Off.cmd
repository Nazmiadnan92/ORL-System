@echo off
title ORL C1 - Deploy Edge Disabled
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-edge-c1.ps1" -State disabled -LoginIfNeeded
pause
