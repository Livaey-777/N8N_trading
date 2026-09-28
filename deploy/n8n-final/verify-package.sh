#!/bin/sh
# Static audit of the n8n import package: node verify-package.js (see that file for the checks). Needs Node.js,
# which every n8n host has (on a Docker-only host: docker run ... --entrypoint node <n8n image> verify-package.js).
set -eu
exec node "$(dirname "$0")/verify-package.js" "$@"
