@echo off
rem Review launcher: see docs/REVIEW.md. Usable from any directory by full path.
node "%~dp0tools\review.js" %*
exit /b %errorlevel%
