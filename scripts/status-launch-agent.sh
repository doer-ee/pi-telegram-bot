#!/bin/bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/launch-agent-common.sh"

printf 'Label: %s\n' "$LAUNCH_AGENT_LABEL"
printf 'Project root: %s\n' "$PROJECT_ROOT"
printf 'Project env: %s\n' "$PROJECT_ENV_PATH"
printf 'Built entrypoint: %s\n' "$DIST_ENTRY_PATH"
printf 'Installed plist: %s\n' "$INSTALLED_PLIST_PATH"
printf 'Stdout log: %s\n' "$STDOUT_LOG_PATH"
printf 'Stderr log: %s\n' "$STDERR_LOG_PATH"
printf 'Launchd domain: %s\n' "$USER_DOMAIN_TARGET"

if [[ -f "$INSTALLED_PLIST_PATH" ]]; then
	printf 'Plist installed: yes\n'
else
	printf 'Plist installed: no\n'
fi

if "$LAUNCHCTL_BIN" print "$USER_DOMAIN_TARGET" >/dev/null 2>&1; then
	printf 'GUI domain available: yes\n'
else
	printf 'GUI domain available: no\n'
fi

if is_service_loaded; then
	printf 'LaunchAgent loaded: yes\n\n'
	"$LAUNCHCTL_BIN" print "$SERVICE_TARGET"
	exit 0
fi

printf 'LaunchAgent loaded: no\n'
