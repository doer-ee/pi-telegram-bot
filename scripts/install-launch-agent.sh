#!/bin/bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/launch-agent-common.sh"

ensure_gui_domain_available
ensure_service_definition_assets
ensure_runtime_assets
ensure_launch_agents_dir
ensure_log_dir

temp_plist="$(mktemp "${TMPDIR:-/tmp}/pi-telegram-bot-launch-agent.XXXXXX.plist")"
trap '/bin/rm -f "$temp_plist"' EXIT

"$SCRIPT_DIR/generate-launch-agent-plist.sh" "$temp_plist" >/dev/null

bootout_service_if_loaded
"$INSTALL_BIN" -m 0644 "$temp_plist" "$INSTALLED_PLIST_PATH"
"$LAUNCHCTL_BIN" bootstrap "$USER_DOMAIN_TARGET" "$INSTALLED_PLIST_PATH"

log_info "Installed LaunchAgent $LAUNCH_AGENT_LABEL"
log_info "Plist: $INSTALLED_PLIST_PATH"
log_info "Logs: $STDOUT_LOG_PATH and $STDERR_LOG_PATH"
log_info "Use 'bun run service:status' to inspect the loaded agent."
