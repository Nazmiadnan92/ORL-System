@echo off
title ORL - C7 Recovery and Live Checks Only
"C:\Users\Nazmi Adnan\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" -NoProfile -File "%~dp0verify-c7.ps1"
if errorlevel 1 goto stopped
"C:\Users\Nazmi Adnan\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" -NoProfile -File "%~dp0observe-c7.ps1"
if errorlevel 1 goto stopped
echo SUCCESS: C7 recovery and live observation passed.
pause
exit /b 0
:stopped
echo STOP: C7 checks incomplete. Do not reinstall 052 if already installed.
pause
exit /b 1
