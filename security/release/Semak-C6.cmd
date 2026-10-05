@echo off
title ORL - C6 Status Only
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-c6.ps1" -StatusOnly
pause
