@echo off
title ORL - Global Sub-specialty Statistics 059
"C:\Users\Nazmi Adnan\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" -NoProfile -File "%~dp0install-059.ps1"
if errorlevel 1 goto stopped
pause
exit /b 0
:stopped
echo STOP: Share only the error screenshot, not passwords. Do not repeat blindly.
pause
exit /b 1
