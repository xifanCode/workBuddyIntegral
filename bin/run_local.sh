#!/bin/sh
# WorkBuddy「Buddy 加油站」每日自动化 —— 本地调度入口（launchd / cron 共用）。
# Copyright (c) 2026 xifan · https://github.com/xifanCode/workBuddyIntegral
#
# 运行时策略（无需 Python）：
#   解密 sym-v1 加密凭据必须使用 WorkBuddy 桌面端自带的 Electron 二进制
#   （原生绑定 electron_browser_workbuddy_storage 只存在于该二进制中，纯 node 没有）。
#   因此首选直接用该二进制以 node 模式跑脚本 —— 零额外依赖；
#   取不到再退到托管/系统 node（脚本内部会自行重启到 Electron 二进制）。
#
# token 不落盘：脚本本身只在内存里用 token，输出已脱敏；本脚本只把脱敏后的结果写日志。
set -u

# 自定位：无论专家包被安装到哪个用户目录，都从脚本自身所在目录解析。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR"
LOG_DIR="$APP_DIR/logs"
JS="$APP_DIR/wb_buddy_auto.js"
mkdir -p "$LOG_DIR"

# 解密用的 WorkBuddy 运行时要能写临时目录；cron/精简环境可能没给 TMPDIR，这里兜底。
export HOME="${HOME:-/Users/xifan}"
export TMPDIR="${TMPDIR:-/tmp}"

# 先给一个稳妥的基础 PATH（launchd/cron 的精简环境里 date/tee/mkdir 也要能用）。
PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

log() { echo "$(date '+%F %T') $*" >> "$LOG_DIR/run.log"; }

# 执行并把（已脱敏的）结果同时写日志与 stdout，保留真实退出码。
run_and_log() {
  _out="$("$@" 2>&1)"
  _code=$?
  printf '%s\n' "$_out" | tee -a "$LOG_DIR/run.log"
  return $_code
}

# ---- 定位 WorkBuddy 桌面端的可执行文件（解密必需）----
find_runtime() {
  case "$(uname -s 2>/dev/null)" in
    Darwin)
      for app in "/Applications/WorkBuddy.app" "$HOME/Applications/WorkBuddy.app"; do
        [ -d "$app" ] || continue
        exe=""
        if command -v defaults >/dev/null 2>&1; then
          exe="$(defaults read "$app/Contents/Info" CFBundleExecutable 2>/dev/null)"
        fi
        if [ -z "$exe" ]; then
          exe="$(sed -n 's/.*<key>CFBundleExecutable<\/key>[[:space:]]*<string>\([^<]*\)<\/string>.*/\1/p' \
                 "$app/Contents/Info.plist" 2>/dev/null | head -1)"
        fi
        [ -n "$exe" ] || exe="WorkBuddy"
        cand="$app/Contents/MacOS/$exe"
        [ -x "$cand" ] && { echo "$cand"; return 0; }
      done
      ;;
    *)
      for c in "$LOCALAPPDATA/Programs/WorkBuddy/WorkBuddy.exe" \
               "$PROGRAMFILES/WorkBuddy/WorkBuddy.exe" \
               "${PROGRAMFILES(X86)}/WorkBuddy/WorkBuddy.exe"; do
        [ -n "$c" ] && [ -f "$c" ] && { echo "$c"; return 0; }
      done
      ;;
  esac
  return 1
}

RUNTIME="$(find_runtime || true)"

# ---- 托管 node（仅在没有 Electron 二进制时作为启动器）----
MG_NODE=""
for d in "$HOME/.workbuddy/binaries/node/versions/current/bin" \
         "$HOME/.workbuddy/binaries/node/envs/default/bin"; do
  [ -x "$d/node" ] && { MG_NODE="$d/node"; break; }
done
# versions/current 可能是记录版本号的文本文件而非目录，按其中的版本号再解析一次
if [ -z "$MG_NODE" ]; then
  _cur="$HOME/.workbuddy/binaries/node/versions/current"
  if [ -f "$_cur" ]; then
    _v="$(cat "$_cur" 2>/dev/null)"
    if [ -n "$_v" ] && [ -x "$HOME/.workbuddy/binaries/node/versions/$_v/bin/node" ]; then
      MG_NODE="$HOME/.workbuddy/binaries/node/versions/$_v/bin/node"
    fi
  fi
fi

if [ ! -f "$JS" ]; then
  log "ERROR: 未找到脚本 $JS，放弃本次运行"
  exit 127
fi

# ---- 启动（按优先级：WorkBuddy Electron > 托管 node > 系统 node）----
if [ -n "$RUNTIME" ]; then
  log "run interpreter=workbuddy-electron runtime=$RUNTIME pid=$$"
  export ELECTRON_RUN_AS_NODE=1
  run_and_log "$RUNTIME" "$JS" run
  exit $?
elif [ -n "$MG_NODE" ]; then
  log "run interpreter=managed-node node=$MG_NODE pid=$$"
  run_and_log "$MG_NODE" "$JS" run
  exit $?
elif command -v node >/dev/null 2>&1; then
  log "run interpreter=system-node pid=$$"
  run_and_log node "$JS" run
  exit $?
else
  log "ERROR: 未找到可用 JS 运行时（WorkBuddy 客户端 / node），放弃本次运行"
  exit 127
fi
