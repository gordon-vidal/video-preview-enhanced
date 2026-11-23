# Kept so existing PowerShell calls work; the launcher is review.js (docs/REVIEW.md).
& node (Join-Path $PSScriptRoot 'review.js') @args
exit $LASTEXITCODE
