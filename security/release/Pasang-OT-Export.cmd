@echo off
title ORL - Install Audited OT List Export
"C:\Users\Nazmi Adnan\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" -NoProfile -File "%~dp0install-053.ps1"
if errorlevel 1 goto stopped
"C:\Users\Nazmi Adnan\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" -NoProfile -File "%~dp0deploy-edge-ot-export.ps1"
if errorlevel 1 goto stopped
echo SUCCESS: OT export backend installed. Tell GPT to verify and publish the website.
pause
exit /b 0
:stopped
echo STOP: Do not rerun blindly. Share the error screenshot only, not passwords.
pause
exit /b 1
