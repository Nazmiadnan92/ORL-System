@echo off
title ORL - Read-Only Check Migration 047
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-047.ps1"
pause
