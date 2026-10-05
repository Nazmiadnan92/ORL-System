@echo off
title ORL - Deploy C6 Edge Gateway
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-edge-c6.ps1"
pause
