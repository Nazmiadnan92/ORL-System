@echo off
title ORL - Read-Only 070 Baseline Check
"C:\Users\Nazmi Adnan\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" -NoProfile -File "%~dp0inspect-070-baseline.ps1"
if errorlevel 1 goto stopped
pause
exit /b 0
:stopped
echo STOP: Share only the status screenshot, not passwords or private report contents.
pause
exit /b 1
