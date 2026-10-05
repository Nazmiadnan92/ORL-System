@echo off
title ORL - Backup After C2
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup-after-c2.ps1"
pause
