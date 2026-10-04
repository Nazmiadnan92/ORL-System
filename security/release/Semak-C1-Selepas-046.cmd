@echo off
title ORL C1 - Read-Only Post-046 Check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0preflight-c1.ps1" -PostInstall
pause
