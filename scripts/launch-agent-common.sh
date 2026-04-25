#!/bin/bash

set -euo pipefail

readonly LAUNCHCTL_BIN="/bin/launchctl"
readonly PLUTIL_BIN="/usr/bin/plutil"
readonly INSTALL_BIN="/usr/bin/install"
readonly LAUNCH_AGENT_LABEL="com.doer.pi-telegram-bot"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
readonly PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
readonly PROJECT_ENV_PATH="$PROJECT_ROOT/.env"
readonly DIST_ENTRY_PATH="$PROJECT_ROOT/dist/index.js"
readonly LAUNCHD_DIR="$PROJECT_ROOT/launchd"
readonly LAUNCHD_TEMPLATE_PATH="$LAUNCHD_DIR/$LAUNCH_AGENT_LABEL.plist.template"
readonly PROJECT_LOG_DIR="$PROJECT_ROOT/tmp/logs/launchd"
readonly STDOUT_LOG_PATH="$PROJECT_LOG_DIR/stdout.log"
readonly STDERR_LOG_PATH="$PROJECT_LOG_DIR/stderr.log"
readonly USER_LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
readonly INSTALLED_PLIST_PATH="$USER_LAUNCH_AGENTS_DIR/$LAUNCH_AGENT_LABEL.plist"
readonly USER_DOMAIN_TARGET="gui/$(/usr/bin/id -u)"
readonly SERVICE_TARGET="$USER_DOMAIN_TARGET/$LAUNCH_AGENT_LABEL"

log_info() {
	printf '[pi-telegram-bot] %s\n' "$*"
}

log_error() {
	printf '[pi-telegram-bot] ERROR: %s\n' "$*" >&2
}

fail() {
	log_error "$*"
	exit 1
}

to_absolute_path() {
	local path="$1"

	if [[ "$path" == /* ]]; then
		printf '%s\n' "$path"
		return 0
	fi

	printf '%s\n' "$PWD/$path"
}

ensure_gui_domain_available() {
	if ! "$LAUNCHCTL_BIN" print "$USER_DOMAIN_TARGET" >/dev/null 2>&1; then
		fail "launchd GUI domain $USER_DOMAIN_TARGET is not available. Run this from the logged-in macOS user session."
	fi
}

ensure_service_definition_assets() {
	[[ -f "$LAUNCHD_TEMPLATE_PATH" ]] || fail "LaunchAgent plist template is missing: $LAUNCHD_TEMPLATE_PATH"
}

ensure_runtime_assets() {
	[[ -f "$PROJECT_ENV_PATH" ]] || fail "Project env file is missing: $PROJECT_ENV_PATH"
	[[ -f "$DIST_ENTRY_PATH" ]] || fail "Built entrypoint is missing: $DIST_ENTRY_PATH. Run 'bun run build' first."
}

ensure_launch_agents_dir() {
	/bin/mkdir -p "$USER_LAUNCH_AGENTS_DIR"
}

ensure_log_dir() {
	/bin/mkdir -p "$PROJECT_LOG_DIR"
}

ensure_installed_plist() {
	[[ -f "$INSTALLED_PLIST_PATH" ]] || fail "LaunchAgent plist is not installed at $INSTALLED_PLIST_PATH. Run 'bun run service:install' first."
}

resolve_node_binary() {
	if ! command -v node >/dev/null 2>&1; then
		fail "node was not found in PATH. Install Node 20+ and rerun this command."
	fi

	local node_binary
	node_binary="$(node -p 'process.execPath' 2>/dev/null || true)"

	if [[ -z "$node_binary" ]]; then
		node_binary="$(command -v node)"
	fi

	[[ -x "$node_binary" ]] || fail "Resolved node binary is not executable: $node_binary"
	printf '%s\n' "$node_binary"
}

build_service_path() {
	local node_binary="$1"
	local node_dir
	node_dir="$(dirname "$node_binary")"
	printf '%s\n' "$node_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

escape_sed_replacement() {
	printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'
}

render_launch_agent_plist() {
	local output_path="$1"
	local node_binary="$2"
	local service_path="$3"

	sed \
		-e "s/__LABEL__/$(escape_sed_replacement "$LAUNCH_AGENT_LABEL")/g" \
		-e "s#__DIST_ENTRY_PATH__#$(escape_sed_replacement "$DIST_ENTRY_PATH")#g" \
		-e "s#__PROJECT_ROOT__#$(escape_sed_replacement "$PROJECT_ROOT")#g" \
		-e "s#__HOME__#$(escape_sed_replacement "$HOME")#g" \
		-e "s#__PATH__#$(escape_sed_replacement "$service_path")#g" \
		-e "s#__NODE_BINARY__#$(escape_sed_replacement "$node_binary")#g" \
		-e "s#__ENV_PATH__#$(escape_sed_replacement "$PROJECT_ENV_PATH")#g" \
		-e "s#__LOG_DIR__#$(escape_sed_replacement "$PROJECT_LOG_DIR")#g" \
		-e "s#__STDOUT_LOG_PATH__#$(escape_sed_replacement "$STDOUT_LOG_PATH")#g" \
		-e "s#__STDERR_LOG_PATH__#$(escape_sed_replacement "$STDERR_LOG_PATH")#g" \
		"$LAUNCHD_TEMPLATE_PATH" >"$output_path"
}

validate_plist() {
	local plist_path="$1"
	"$PLUTIL_BIN" -lint "$plist_path" >/dev/null
}

is_service_loaded() {
	"$LAUNCHCTL_BIN" print "$SERVICE_TARGET" >/dev/null 2>&1
}

bootout_service_if_loaded() {
	if ! is_service_loaded; then
		return 0
	fi

	if "$LAUNCHCTL_BIN" bootout "$USER_DOMAIN_TARGET" "$INSTALLED_PLIST_PATH" >/dev/null 2>&1; then
		return 0
	fi

	if "$LAUNCHCTL_BIN" bootout "$SERVICE_TARGET" >/dev/null 2>&1; then
		return 0
	fi

	if is_service_loaded; then
		fail "Failed to unload LaunchAgent $LAUNCH_AGENT_LABEL"
	fi
}
