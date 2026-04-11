#!/usr/bin/env bash
# mac-storage-sweep — 引导式 / 命令行 清理常被算进「系统数据」的用户侧缓存
#
# 无参数：进入交互向导（推荐）
# --report：仅打印各目标体积（旧版默认行为）
# --apply --targets a,b --yes：非交互执行
#
set -euo pipefail

DRY_RUN=1
TARGETS_RAW=""
ASSUME_YES=0
GUIDED=0
REPORT_ONLY=0
RAW_ARGC=$#

usage() {
  cat <<'EOF'
mac-storage-sweep — macOS 储存「系统数据」常见来源（用户缓存等）

用法：
  ./scripts/mac-storage-sweep.sh              交互向导（推荐）
  ./scripts/mac-storage-sweep.sh --report     仅查看各项目占用
  ./scripts/mac-storage-sweep.sh --apply --targets user-caches,xcode-deriveddata --yes

选项：
  --guided       显式进入交互向导（与无参数相同）
  --report       列出所有目标体积后退出
  --apply        执行删除（须配合 --targets）
  --targets LIST 逗号分隔目标 id
  --yes          跳过每次确认（须配合 --apply）
  -h, --help     帮助

目标 id 与说明见向导内列表；不处理 APFS 快照，不删除 /System。
EOF
}

log() { printf '%s\n' "$*"; }

hr() { printf '%s\n' "────────────────────────────────────────"; }

dir_size_human() {
  local p="$1"
  if [[ -e "$p" ]]; then
    du -sh "$p" 2>/dev/null | awk '{print $1}'
  else
    echo "0B"
  fi
}

target_label_zh() {
  case "$1" in
    user-caches) echo "用户应用缓存" ;;
    user-logs-old) echo "旧日志（>30 天 .log/.asl）" ;;
    xcode-deriveddata) echo "Xcode DerivedData（可重建）" ;;
    xcode-archives) echo "Xcode Archives（历史 IPA，慎用）" ;;
    coresim-caches) echo "iOS 模拟器 Caches" ;;
    brew-cleanup) echo "Homebrew 旧包缓存" ;;
    npm-cache) echo "npm 全局缓存" ;;
    pnpm-store-prune) echo "pnpm store 修剪" ;;
    pip-cache) echo "pip 缓存" ;;
    docker-prune) echo "Docker 未使用镜像/容器（慎用）" ;;
    *) echo "$1" ;;
  esac
}

target_risk() {
  case "$1" in
    xcode-archives|docker-prune) echo "high" ;;
    user-caches) echo "low" ;;
    *) echo "low" ;;
  esac
}

confirm() {
  local msg="$1"
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    return 0
  fi
  read -r -p "$msg [y/N] " ans || true
  [[ "${ans:-}" =~ ^[yY]$ ]]
}

ALL_TARGETS=(
  user-caches
  user-logs-old
  xcode-deriveddata
  xcode-archives
  coresim-caches
  brew-cleanup
  npm-cache
  pnpm-store-prune
  pip-cache
  docker-prune
)

# 向导中的「推荐」组合（不含 Archives / Docker）
RECOMMENDED_TARGETS=(
  user-caches
  user-logs-old
  xcode-deriveddata
  coresim-caches
  brew-cleanup
  npm-cache
  pnpm-store-prune
  pip-cache
)

target_size_preview() {
  local name="$1"
  case "$name" in
    user-caches) dir_size_human "$HOME/Library/Caches" ;;
    user-logs-old) dir_size_human "$HOME/Library/Logs" ;;
    xcode-deriveddata) dir_size_human "$HOME/Library/Developer/Xcode/DerivedData" ;;
    xcode-archives) dir_size_human "$HOME/Library/Developer/Xcode/Archives" ;;
    coresim-caches) dir_size_human "$HOME/Library/Developer/CoreSimulator/Caches" ;;
    brew-cleanup)
      if command -v brew >/dev/null 2>&1; then echo "（已安装）"; else echo "—"; fi
      ;;
    npm-cache)
      if command -v npm >/dev/null 2>&1; then echo "（已安装）"; else echo "—"; fi
      ;;
    pnpm-store-prune)
      if command -v pnpm >/dev/null 2>&1; then echo "（已安装）"; else echo "—"; fi
      ;;
    pip-cache)
      if command -v pip3 >/dev/null 2>&1 || command -v pip >/dev/null 2>&1; then echo "（已安装）"; else echo "—"; fi
      ;;
    docker-prune)
      if command -v docker >/dev/null 2>&1; then echo "（已安装）"; else echo "—"; fi
      ;;
    *) echo "?" ;;
  esac
}

run_target() {
  local name="$1"
  case "$name" in
    user-caches)
      local p="$HOME/Library/Caches"
      local sz
      sz="$(dir_size_human "$p")"
      log "[user-caches] $p → $sz"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        confirm "将删除整个用户 Caches 目录内容（应用会重建缓存）" || return 1
        find "$p" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
        log "  完成"
      fi
      ;;
    user-logs-old)
      local p="$HOME/Library/Logs"
      local sz
      sz="$(dir_size_human "$p")"
      log "[user-logs-old] $p（仅 >30 天的 *.log / *.asl）→ 当前目录约 $sz"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        confirm "将删除 $p 下超过 30 天的 .log / .asl" || return 1
        find "$p" -type f \( -name '*.log' -o -name '*.asl' \) -mtime +30 -print -delete 2>/dev/null || true
        log "  完成"
      fi
      ;;
    xcode-deriveddata)
      local p="$HOME/Library/Developer/Xcode/DerivedData"
      local sz
      sz="$(dir_size_human "$p")"
      log "[xcode-deriveddata] $p → $sz"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        confirm "将删除 Xcode DerivedData（下次编译会重新生成）" || return 1
        rm -rf "${p:?}/"* 2>/dev/null || true
        log "  完成"
      fi
      ;;
    xcode-archives)
      local p="$HOME/Library/Developer/Xcode/Archives"
      local sz
      sz="$(dir_size_human "$p")"
      log "[xcode-archives] $p → $sz"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        confirm "将删除 Xcode Archives（历史归档 IPA 等），确定？" || return 1
        rm -rf "${p:?}/"* 2>/dev/null || true
        log "  完成"
      fi
      ;;
    coresim-caches)
      local p="$HOME/Library/Developer/CoreSimulator/Caches"
      local sz
      sz="$(dir_size_human "$p")"
      log "[coresim-caches] $p → $sz"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        confirm "将删除 iOS 模拟器 Caches" || return 1
        rm -rf "${p:?}/"* 2>/dev/null || true
        log "  完成"
      fi
      ;;
    brew-cleanup)
      if ! command -v brew >/dev/null 2>&1; then
        log "[brew-cleanup] 未安装 brew，跳过"
        return 0
      fi
      log "[brew-cleanup] 将执行: brew cleanup -s --prune=all"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        confirm "执行 Homebrew 清理？" || return 1
        brew cleanup -s --prune=all 2>/dev/null || brew cleanup -s || true
        log "  完成"
      fi
      ;;
    npm-cache)
      if ! command -v npm >/dev/null 2>&1; then
        log "[npm-cache] 未安装 npm，跳过"
        return 0
      fi
      log "[npm-cache] 将执行: npm cache clean --force"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        confirm "清空 npm 全局缓存？" || return 1
        npm cache clean --force || true
        log "  完成"
      fi
      ;;
    pnpm-store-prune)
      if ! command -v pnpm >/dev/null 2>&1; then
        log "[pnpm-store-prune] 未安装 pnpm，跳过"
        return 0
      fi
      log "[pnpm-store-prune] 将执行: pnpm store prune"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        confirm "修剪 pnpm store？" || return 1
        pnpm store prune || true
        log "  完成"
      fi
      ;;
    pip-cache)
      if ! command -v pip3 >/dev/null 2>&1 && ! command -v pip >/dev/null 2>&1; then
        log "[pip-cache] 未安装 pip，跳过"
        return 0
      fi
      local pipc
      pipc="pip3"
      command -v pip3 >/dev/null 2>&1 || pipc="pip"
      log "[pip-cache] 将执行: $pipc cache purge"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        confirm "清空 pip 缓存？" || return 1
        "$pipc" cache purge || true
        log "  完成"
      fi
      ;;
    docker-prune)
      if ! command -v docker >/dev/null 2>&1; then
        log "[docker-prune] 未安装 docker，跳过"
        return 0
      fi
      log "[docker-prune] 将执行: docker system prune -af（删除未使用镜像/网络/构建缓存）"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        confirm "执行 Docker 深度清理？镜像需重新拉取" || return 1
        docker system prune -af || true
        log "  完成"
      fi
      ;;
    "")
      ;;
    *)
      log "未知目标: $name（见 --help）"
      return 2
      ;;
  esac
}

run_guided() {
  HOME="${HOME:-$(eval echo ~"$USER")}"
  export HOME

  clear 2>/dev/null || true

  log ""
  log "  mac-storage-sweep — 储存清理向导"
  hr
  log ""
  log "  本工具只处理「用户目录下」的白名单缓存（例如 ~/Library/Caches、"
  log "  Xcode 构建缓存等）。不会删除系统快照或 /System。"
  log ""
  log "  「系统数据」在系统设置里是许多项的总和；清理后界面数字可能"
  log "  延迟更新，属正常现象。"
  log ""
  hr
  read -r -p "按回车开始扫描各项目占用… " _ || true
  log ""
  log "扫描结果（编号用于下一步选择）："
  log ""

  local i=1 t sz
  for t in "${ALL_TARGETS[@]}"; do
    sz="$(target_size_preview "$t")"
    printf '  %2d  %-22s 约 %s\n' "$i" "$(target_label_zh "$t")" "$sz"
    ((i++)) || true
  done

  log ""
  log "  风险较高项：Xcode Archives、Docker 清理（见上表编号）。"
  hr
  log ""
  log "请选择要执行清理的项目："
  log "  • 输入编号，多个用空格或逗号分隔（例: 1 3 5 或 1,3,5）"
  log "  • 输入 r 使用推荐组合（不含 Archives / Docker）"
  log "  • 输入 q 退出不清理"
  log ""
  read -r -p "> " choice_raw || true
  choice_raw="${choice_raw//,/ }"
  choice_raw="${choice_raw//+/ }"

  declare -a SELECTED=()
  if [[ "${choice_raw:-}" =~ ^[qQ]$ ]]; then
    log "已取消。"
    exit 0
  fi
  if [[ "${choice_raw:-}" =~ ^[rR]$ ]]; then
    SELECTED=("${RECOMMENDED_TARGETS[@]}")
  else
    for tok in $choice_raw; do
      if [[ "$tok" =~ ^[0-9]+$ ]]; then
        local idx=$((tok - 1))
        if (( idx >= 0 && idx < ${#ALL_TARGETS[@]} )); then
          SELECTED+=("${ALL_TARGETS[idx]}")
        else
          log "忽略无效编号: $tok"
        fi
      elif [[ -n "$tok" ]]; then
        log "忽略无法识别的输入: $tok"
      fi
    done
  fi

  if [[ ${#SELECTED[@]} -eq 0 ]]; then
    log "未选择任何项目，退出。"
    exit 0
  fi

  log ""
  log "你将清理以下项目："
  for t in "${SELECTED[@]}"; do
    log "  - $(target_label_zh "$t") ($t)"
  done
  log ""
  read -r -p "确认执行清理？输入 YES 继续，其它键取消: " final || true
  if [[ "${final:-}" != "YES" ]]; then
    log "已取消。"
    exit 0
  fi

  DRY_RUN=0
  ASSUME_YES=1
  log ""
  log "=== 开始执行 ==="
  log ""

  for t in "${SELECTED[@]}"; do
    run_target "$t" || true
    log ""
  done

  log "=== 执行结束 ==="
  log "可在「系统设置 → 通用 → 储存空间」稍后查看变化。"
}

# ---------- 参数解析 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) DRY_RUN=0 ;;
    --dry-run) DRY_RUN=1 ;;
    --targets)
      TARGETS_RAW="${2:-}"
      shift
      ;;
    --yes) ASSUME_YES=1 ;;
    --guided) GUIDED=1 ;;
    --report) REPORT_ONLY=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log "未知参数: $1"
      usage
      exit 2
      ;;
  esac
  shift || true
done

if [[ "$DRY_RUN" -eq 0 && -z "$TARGETS_RAW" && "$GUIDED" -eq 0 ]]; then
  log "错误: --apply 必须配合 --targets=... 使用；或在不带参数的可交互终端运行向导。"
  exit 2
fi

HOME="${HOME:-$(eval echo ~"$USER")}"
export HOME

declare -a SELECTED=()
if [[ -n "$TARGETS_RAW" ]]; then
  IFS=',' read -r -a SELECTED <<<"$TARGETS_RAW"
fi

if [[ "$GUIDED" -eq 1 ]]; then
  run_guided
  exit 0
fi

# 无参数：可交互则进入向导，否则打印报告（便于管道/自动化）
if [[ "$RAW_ARGC" -eq 0 && "$REPORT_ONLY" -eq 0 && "$DRY_RUN" -eq 1 && -z "$TARGETS_RAW" ]]; then
  if [[ -t 0 ]]; then
    run_guided
    exit 0
  fi
  REPORT_ONLY=1
fi

if [[ "$REPORT_ONLY" -eq 1 ]]; then
  log "=== mac-storage-sweep — 仅报告 ==="
  log "HOME=$HOME"
  log ""
  for t in "${ALL_TARGETS[@]}"; do
    run_target "$t" || exit $?
    log ""
  done
  log "提示: 交互向导请直接运行 $0"
  log "非交互清理: $0 --apply --targets user-caches,xcode-deriveddata --yes"
  exit 0
fi

log "=== mac-storage-sweep ==="
log "HOME=$HOME"
if [[ "$DRY_RUN" -eq 1 ]]; then
  log "模式: 仅分析（dry-run）"
else
  log "模式: 将执行删除（apply）"
fi
log ""

if [[ ${#SELECTED[@]} -eq 0 ]]; then
  for t in "${ALL_TARGETS[@]}"; do
    run_target "$t" || exit $?
    log ""
  done
  log "提示: 执行清理请使用:"
  log "  $0                  # 交互向导"
  log "  $0 --apply --targets user-caches,xcode-deriveddata --yes"
  exit 0
fi

for t in "${SELECTED[@]}"; do
  [[ -z "$t" ]] && continue
  run_target "$t" || exit $?
  log ""
done

log "全部处理结束。"
