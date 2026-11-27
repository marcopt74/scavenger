#!/usr/bin/env bash
set -euo pipefail

# Scavenger startup script
# Usage: ./scripts/start.sh [--dev | --prod] [--build] [--port PORT] [--open] [--install]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

MODE="dev"
FORCE_BUILD=false
FORCE_INSTALL=false
OPEN_BROWSER=false
CLI_PORT=""
VITE_PORT=5173

# Colors (only when connected to a terminal)
if [ -t 1 ]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  CYAN=$'\033[36m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  RED=$'\033[31m'
  RESET=$'\033[0m'
else
  BOLD=""
  DIM=""
  CYAN=""
  GREEN=""
  YELLOW=""
  RED=""
  RESET=""
fi

info()  { printf "%s[scavenger]%s %s\n" "$CYAN$BOLD" "$RESET" "$1"; }
ok()    { printf "%s[scavenger]%s %s\n" "$GREEN$BOLD" "$RESET" "$1"; }
warn()  { printf "%s[scavenger]%s %s\n" "$YELLOW$BOLD" "$RESET" "$1" >&2; }
error() { printf "%s[scavenger]%s %s\n" "$RED$BOLD" "$RESET" "$1" >&2; }

usage() {
  cat <<EOF
${BOLD}Scavenger Startup Script${RESET}

Usage:
  ./scripts/start.sh [options]

Options:
  --dev           Start in development mode with hot reload (default)
                  Frontend: http://localhost:${VITE_PORT} | Backend API: http://localhost:<port>
  --prod          Start in production mode (serves built UI + API on http://localhost:<port>)
  --build         Force a fresh production build before starting (implies --prod)
  --port <PORT>   Set backend server port (defaults to PORT env/.env or 3001)
  --open          Open Scavenger in your default browser once ready
  --install       Install/update dependencies before starting
  -h, --help      Show this help message

Examples:
  ./scripts/start.sh
  ./scripts/start.sh --open
  ./scripts/start.sh --prod --open
  ./scripts/start.sh --prod --build --port 4000
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)
      MODE="dev"
      shift
      ;;
    --prod)
      MODE="prod"
      shift
      ;;
    --build)
      MODE="prod"
      FORCE_BUILD=true
      shift
      ;;
    --port)
      if [[ $# -lt 2 ]] || [[ -z "${2:-}" ]]; then
        error "Option --port requires a numeric port argument."
        exit 1
      fi
      CLI_PORT="$2"
      shift 2
      ;;
    --port=*)
      CLI_PORT="${1#*=}"
      shift
      ;;
    --open)
      OPEN_BROWSER=true
      shift
      ;;
    --install)
      FORCE_INSTALL=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      printf "\n" >&2
      usage >&2
      exit 1
      ;;
  esac
done

cd "$ROOT_DIR"

# 1. Verify Node.js >= 20
if ! command -v node >/dev/null 2>&1; then
  error "Node.js is required (>= 20) but was not found in PATH."
  exit 1
fi

NODE_VERSION="$(node -v)"
NODE_MAJOR="$(printf "%s" "$NODE_VERSION" | sed -E 's/^v([0-9]+).*/\1/')"
if [[ -z "$NODE_MAJOR" ]] || (( NODE_MAJOR < 20 )); then
  error "Node.js >= 20 is required (found ${NODE_VERSION})."
  exit 1
fi

# 2. Pick package manager (prefer pnpm, fall back to npm)
if command -v pnpm >/dev/null 2>&1; then
  PKG_MGR="pnpm"
elif command -v npm >/dev/null 2>&1; then
  PKG_MGR="npm"
  warn "pnpm not found; falling back to npm. (Recommended: install pnpm or run 'corepack enable'.)"
else
  error "Neither pnpm nor npm was found in PATH."
  exit 1
fi

# 3. Resolve backend PORT (CLI flag > exported PORT > .env PORT > 3001)
read_env_port() {
  local env_file="$ROOT_DIR/.env"
  if [[ -f "$env_file" ]]; then
    grep -E '^[[:space:]]*PORT[[:space:]]*=' "$env_file" | tail -n 1 | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*#.*$//; s/^["'\'']|["'\'']$//g; s/[[:space:]]+$//' || true
  fi
}

if [[ -n "$CLI_PORT" ]]; then
  SERVER_PORT="$CLI_PORT"
elif [[ -n "${PORT:-}" ]]; then
  SERVER_PORT="$PORT"
else
  ENV_PORT="$(read_env_port)"
  SERVER_PORT="${ENV_PORT:-3001}"
fi

if ! [[ "$SERVER_PORT" =~ ^[0-9]+$ ]] || (( SERVER_PORT < 1 || SERVER_PORT > 65535 )); then
  error "Invalid port: '${SERVER_PORT}'. Expected an integer between 1 and 65535."
  exit 1
fi

export PORT="$SERVER_PORT"

if [[ "$MODE" == "dev" && "$SERVER_PORT" != "3001" ]]; then
  warn "Vite's dev proxy in vite.config.ts targets http://localhost:3001; using PORT=${SERVER_PORT} in --dev mode may cause /api proxy requests to fail."
fi

# 4. Install dependencies if missing or requested
if [[ "$FORCE_INSTALL" == true ]] || [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  info "Installing dependencies with ${PKG_MGR}..."
  "$PKG_MGR" install
fi

# 5. Check for port conflicts before starting
check_port_free() {
  local port="$1"
  local label="$2"
  if command -v lsof >/dev/null 2>&1; then
    local pid
    pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
    if [[ -n "$pid" ]]; then
      local proc_name
      proc_name="$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")"
      error "Port ${port} (${label}) is already in use by PID ${pid} (${proc_name})."
      error "Stop that process or choose a different port with --port <PORT>."
      exit 1
    fi
  fi
}

check_port_free "$SERVER_PORT" "backend API"
if [[ "$MODE" == "dev" ]]; then
  check_port_free "$VITE_PORT" "Vite dev server"
fi

# 6. Helper to open the browser once the server is healthy
open_when_ready() {
  local target_url="$1"
  local health_url="$2"
  local parent_pid="$$"

  (
    local attempts=0
    local max_attempts=60
    while (( attempts < max_attempts )); do
      if ! kill -0 "$parent_pid" 2>/dev/null; then
        exit 0
      fi
      if command -v curl >/dev/null 2>&1 && curl -fsS "$health_url" >/dev/null 2>&1; then
        if [[ "$target_url" == "$health_url" ]] || curl -fsS "$target_url" >/dev/null 2>&1; then
          if command -v open >/dev/null 2>&1; then
            open "$target_url" >/dev/null 2>&1 || true
          elif command -v xdg-open >/dev/null 2>&1; then
            xdg-open "$target_url" >/dev/null 2>&1 || true
          fi
          exit 0
        fi
      fi
      attempts=$((attempts + 1))
      sleep 0.5
    done
  ) &
}

# 7. Start Scavenger
HEALTH_URL="http://localhost:${SERVER_PORT}/api/health"

if [[ "$MODE" == "prod" ]]; then
  if [[ "$FORCE_BUILD" == true ]] || [[ ! -f "$ROOT_DIR/dist/server/server/index.js" ]] || [[ ! -d "$ROOT_DIR/dist/client" ]]; then
    info "Building Scavenger for production..."
    "$PKG_MGR" run build
  fi

  APP_URL="http://localhost:${SERVER_PORT}"
  ok "Starting Scavenger in production mode..."
  printf "  %sApp & API:%s %s\n" "$DIM" "$RESET" "$APP_URL"
  printf "  %sRuntime:%s   Node %s (%s)\n\n" "$DIM" "$RESET" "$NODE_VERSION" "$PKG_MGR"

  if [[ "$OPEN_BROWSER" == true ]]; then
    open_when_ready "$APP_URL" "$HEALTH_URL"
  fi

  exec "$PKG_MGR" run start
else
  APP_URL="http://localhost:${VITE_PORT}"
  ok "Starting Scavenger in development mode..."
  printf "  %sApp (Vite):%s %s\n" "$DIM" "$RESET" "$APP_URL"
  printf "  %sAPI:%s        http://localhost:%s\n" "$DIM" "$RESET" "$SERVER_PORT"
  printf "  %sRuntime:%s    Node %s (%s)\n\n" "$DIM" "$RESET" "$NODE_VERSION" "$PKG_MGR"

  if [[ "$OPEN_BROWSER" == true ]]; then
    open_when_ready "$APP_URL" "$HEALTH_URL"
  fi

  exec "$PKG_MGR" run dev
fi
