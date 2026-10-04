@echo off
title ORL C1 - Safe Public Edge Smoke
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Test-EdgeC1PublicSmoke.ps1"
pause
