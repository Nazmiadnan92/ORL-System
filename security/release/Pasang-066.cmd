@echo off
title ORL - Webmaster Closed Past Slot Reassign 066
"C:\Users\Nazmi Adnan\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" -NoProfile -File "%~dp0install-066.ps1"
if errorlevel 1 goto stopped
pause
exit /b 0
:stopped
echo STOP: Share only the error screenshot, not passwords. Do not repeat blindly.
pause
exit /b 1
