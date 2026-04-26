#!/bin/bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/launch-agent-common.sh"

if "$LAUNCHCTL_BIN" print "$USER_DOMAIN_TARGET" >/dev/null 2>&1; then
	bootout_service_if_loaded
fi

if [[ -f "$INSTALLED_PLIST_PATH" ]]; then
	/bin/rm -f "$INSTALLED_PLIST_PATH"
	log_info "Removed LaunchAgent plist $INSTALLED_PLIST_PATH"
else
	log_info "LaunchAgent plist is already absent: $INSTALLED_PLIST_PATH"
fi

log_info "LaunchAgent log files were left in place under $PROJECT_LOG_DIR"
