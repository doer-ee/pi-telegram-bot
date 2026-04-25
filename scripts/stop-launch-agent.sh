#!/bin/bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/launch-agent-common.sh"

ensure_gui_domain_available

if is_service_loaded; then
	bootout_service_if_loaded
	log_info "Stopped LaunchAgent $LAUNCH_AGENT_LABEL"
	exit 0
fi

log_info "LaunchAgent $LAUNCH_AGENT_LABEL is not loaded"
