@echo off
rem Review launcher: see docs/REVIEW.md. Usable from any directory by full path.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\review.ps1" %*
exit /b %errorlevel%
