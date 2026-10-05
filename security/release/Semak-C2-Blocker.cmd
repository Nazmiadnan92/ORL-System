@echo off
title ORL - Read-Only C2 Blocker Check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0inspect-c2-blockers.ps1"
pause
