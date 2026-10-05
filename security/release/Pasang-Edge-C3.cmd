@echo off
title ORL - Deploy C3 Authorized Reveal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-edge-c3.ps1"
pause
