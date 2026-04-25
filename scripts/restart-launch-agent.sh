#!/bin/bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/launch-agent-common.sh"

ensure_gui_domain_available
ensure_runtime_assets
ensure_installed_plist
ensure_log_dir

if is_service_loaded; then
	"$LAUNCHCTL_BIN" kickstart -k "$SERVICE_TARGET"
	log_info "Restarted LaunchAgent $LAUNCH_AGENT_LABEL"
	log_info "Logs: $STDOUT_LOG_PATH and $STDERR_LOG_PATH"
	exit 0
fi

"$LAUNCHCTL_BIN" bootstrap "$USER_DOMAIN_TARGET" "$INSTALLED_PLIST_PATH"
log_info "LaunchAgent $LAUNCH_AGENT_LABEL was not loaded. Bootstrapped it instead."
log_info "Logs: $STDOUT_LOG_PATH and $STDERR_LOG_PATH"
