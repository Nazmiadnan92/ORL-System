@echo off
title ORL - C7 Website Check Only
echo C7 WEBSITE CHECK ONLY. No migration, backup or database restore will run.
"C:\Users\Nazmi Adnan\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" -NoProfile -File "%~dp0observe-c7.ps1"
if errorlevel 1 goto stopped
echo SUCCESS: C7 website observation completed. Keep passwords private.
pause
exit /b 0
:stopped
echo STOP: Website observation incomplete. Do not reinstall 052 or repeat recovery.
pause
exit /b 1
