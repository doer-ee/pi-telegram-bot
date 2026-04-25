#!/bin/bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/launch-agent-common.sh"

ensure_service_definition_assets

output_path="${1:-$INSTALLED_PLIST_PATH}"
output_path="$(to_absolute_path "$output_path")"

node_binary="$(resolve_node_binary)"
service_path="$(build_service_path "$node_binary")"

/bin/mkdir -p "$(dirname "$output_path")"
render_launch_agent_plist "$output_path" "$node_binary" "$service_path"
validate_plist "$output_path"

log_info "Wrote LaunchAgent plist to $output_path"
