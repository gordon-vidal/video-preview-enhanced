#!/usr/bin/env sh
# Review launcher: see docs/REVIEW.md. Usable from any directory by full path.
exec node "$(dirname "$0")/tools/review.js" "$@"
