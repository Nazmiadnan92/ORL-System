@echo off
title ORL - Post-C6 Private Backup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup-after-c6.ps1"
pause
