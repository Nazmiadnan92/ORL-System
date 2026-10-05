@echo off
title ORL - Deploy C2 Edge Gateway
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-edge-c2.ps1"
pause
