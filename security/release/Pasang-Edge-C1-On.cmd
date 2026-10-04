@echo off
title ORL C1 - Enable Edge Only (Website Remains Off)
echo This enables only the C1 Edge gateway. The website flag remains OFF.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-edge-c1.ps1" -State enabled -LoginIfNeeded
pause
