@echo off
title ORL - C7 Final Audit and Recovery
"C:\Users\Nazmi Adnan\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" -NoProfile -File "%~dp0install-052.ps1"
if errorlevel 1 goto stopped
"C:\Users\Nazmi Adnan\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" -NoProfile -File "%~dp0verify-c7.ps1"
if errorlevel 1 goto stopped
"C:\Users\Nazmi Adnan\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" -NoProfile -File "%~dp0observe-c7.ps1"
if errorlevel 1 goto stopped
echo SUCCESS: C7 database audit, isolated recovery and live observation passed.
pause
exit /b 0
:stopped
echo STOP: C7 is not complete. Share the error screenshot only, not passwords.
pause
exit /b 1
