@echo off
title ORL C1 - Safe Shared-Rate Smoke
echo Log in to the CURRENT website first. Keep the website C1 flag OFF.
echo Copy sessionStorage.getItem('orl_session_token') locally, then paste only into the hidden prompt.
echo Never paste a session token into chat.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Test-EdgeC1Rate.ps1"
pause
