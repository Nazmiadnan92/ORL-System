@echo off
title ORL C1 - Read-Only Production Preflight
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0preflight-c1.ps1"
pause
