#!/usr/bin/env bash
# lsp-status.sh — LSP Enforcement Kit diagnostic
#
# Prints the current installation + runtime state so users can debug
# "why isn't my Grep blocked?" or "is the kit even active?" without
# manually poking around ~/.claude/.
#
# Usage:
#   bash scripts/lsp-status.sh
#   # or from anywhere after install:
#   bash ~/.claude/scripts/lsp-status.sh
set -euo pipefail

CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/hooks"
STATE_DIR="$CLAUDE_DIR/state"
SETTINGS="$CLAUDE_DIR/settings.json"

# Colors only if stdout is a tty
if [ -t 1 ]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; NC=$'\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; DIM=''; BOLD=''; NC=''
fi

check() { [ "$1" = "ok" ] && printf '%s✓%s' "$GREEN" "$NC" || printf '%s✗%s' "$RED" "$NC"; }

echo "${BOLD}LSP Enforcement Kit — Status${NC}"
echo "============================"
echo

# 1. Hook files installed
EXPECTED_HOOKS=(
  bash-grep-block.js
  bash-code-view-block.js
  lsp-first-guard.js
  lsp-first-glob-guard.js
  lsp-first-read-guard.js
  lsp-pre-delegation.js
  lsp-session-reset.js
  lsp-usage-tracker.js
)
installed=0; missing=()
for h in "${EXPECTED_HOOKS[@]}"; do
  if [ -f "$HOOKS_DIR/$h" ]; then installed=$((installed+1)); else missing+=("$h"); fi
done
helper_ok="no"
if [ -f "$HOOKS_DIR/lib/lsp-suggestions.js" ]; then helper_ok="yes"; fi

status="ok"; [ $installed -eq 8 ] || status="bad"
printf '  Hook files:          %s %d/8 ' "$(check $status)" "$installed"
[ ${#missing[@]} -gt 0 ] && printf '%s(missing: %s)%s' "$DIM" "${missing[*]}" "$NC"
echo
printf '  Shared lib/helper:   %s %s\n' "$(check $([ "$helper_ok" = "yes" ] && echo ok || echo bad))" "$helper_ok"

# 2. Settings.json registration
if [ ! -f "$SETTINGS" ]; then
  echo "  Settings:            $(check bad) $SETTINGS not found"
  exit 1
fi

# Safely parse JSON via node (avoid grep on the file for unrelated keys)
eval "$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$SETTINGS','utf8'));
  const count = (arr, sub) => (arr || []).filter(e => (e.hooks || []).some(h => (h.command || '').includes(sub))).length;
  const pre = s.hooks && s.hooks.PreToolUse || [];
  const post = s.hooks && s.hooks.PostToolUse || [];
  const start = s.hooks && s.hooks.SessionStart || [];
  console.log('PRE_GREP=' + count(pre, 'lsp-first-guard.js'));
  console.log('PRE_GLOB=' + count(pre, 'lsp-first-glob-guard.js'));
  console.log('PRE_BASH=' + count(pre, 'bash-grep-block.js'));
  console.log('PRE_BASH_VIEW=' + count(pre, 'bash-code-view-block.js'));
  console.log('PRE_READ=' + count(pre, 'lsp-first-read-guard.js'));
  console.log('PRE_AGENT=' + count(pre, 'lsp-pre-delegation.js'));
  console.log('POST_TRACKER=' + count(post, 'lsp-usage-tracker.js'));
  console.log('SESSION_RESET=' + count(start, 'lsp-session-reset.js'));
" 2>/dev/null || echo 'PRE_GREP=0 PRE_GLOB=0 PRE_BASH=0 PRE_BASH_VIEW=0 PRE_READ=0 PRE_AGENT=0 POST_TRACKER=0 SESSION_RESET=0')"

total_pre=$((PRE_GREP + PRE_GLOB + PRE_BASH + PRE_BASH_VIEW + PRE_READ + PRE_AGENT))
registered_all=0
[ $PRE_GREP -ge 1 ] && [ $PRE_GLOB -ge 1 ] && [ $PRE_BASH -ge 1 ] && [ $PRE_BASH_VIEW -ge 1 ] && \
  [ $PRE_READ -ge 1 ] && [ $PRE_AGENT -ge 1 ] && \
  [ $POST_TRACKER -ge 1 ] && [ $SESSION_RESET -ge 1 ] && registered_all=1

printf '  Settings registered: %s PreToolUse(%d) PostToolUse(%d) SessionStart(%d)\n' \
  "$(check $([ $registered_all -eq 1 ] && echo ok || echo bad))" \
  "$total_pre" "$POST_TRACKER" "$SESSION_RESET"

# 3. Current cwd state file
CWD_HASH=$(node -e "console.log(require('crypto').createHash('md5').update(process.cwd()).digest('hex').slice(0,12))" 2>/dev/null || echo "")
FLAG="$STATE_DIR/lsp-ready-$CWD_HASH"

echo
echo "${BOLD}State for current cwd${NC} ($(pwd))"
echo "------------------------"
if [ -n "$CWD_HASH" ] && [ -f "$FLAG" ]; then
  eval "$(node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('$FLAG','utf8'));
      console.log('WARMUP_DONE=' + (d.warmup_done ? 'yes' : 'no'));
      console.log('NAV_COUNT=' + (d.nav_count || 0));
      console.log('READ_COUNT=' + (d.read_count || 0));
      console.log('LAST_TOOL=' + (d.last_tool || '(none)'));
      const age = Math.round((Date.now() - (d.timestamp || 0)) / 60000);
      console.log('AGE_MIN=' + age);
    } catch (e) { console.log('WARMUP_DONE=error NAV_COUNT=0 READ_COUNT=0 LAST_TOOL=? AGE_MIN=0'); }
  ")"
  printf '  Warmup done:         %s\n' "$WARMUP_DONE"
  printf '  nav_count:           %d %s(LSP navigation calls)%s\n' "$NAV_COUNT" "$DIM" "$NC"
  printf '  read_count:          %d %s(unique code files read)%s\n' "$READ_COUNT" "$DIM" "$NC"
  printf '  Last tool:           %s %s(%dmin ago)%s\n' "$LAST_TOOL" "$DIM" "$AGE_MIN" "$NC"
  printf '  Flag file:           %s%s%s\n' "$DIM" "$FLAG" "$NC"

  echo
  if [ "$WARMUP_DONE" = "yes" ] && [ "$NAV_COUNT" -ge 2 ]; then
    echo "  ${GREEN}✓${NC} Surgical mode active — all Reads unlimited for this session."
  elif [ "$WARMUP_DONE" = "yes" ] && [ "$NAV_COUNT" -ge 1 ]; then
    echo "  ${YELLOW}!${NC} Gate 4 open (reads 4-5 allowed). Make 1 more LSP nav call to unlock surgical mode."
  elif [ "$WARMUP_DONE" = "yes" ]; then
    echo "  ${YELLOW}!${NC} Warmup done, but 0 navigation calls. Gate 3 warn / Gate 4 block on next reads."
  else
    echo "  ${YELLOW}!${NC} Not warmed up. Gate 1 will block the first Read of a code file."
  fi
else
  echo "  ${DIM}No state file for this cwd yet. First Read of a code file will trigger Gate 1 warmup.${NC}"
  [ -n "$CWD_HASH" ] && echo "  ${DIM}Expected path: $FLAG${NC}"
fi

echo
echo "${BOLD}Diagnostic summary${NC}"
echo "------------------"
[ $installed -eq 8 ] && [ $registered_all -eq 1 ] && [ "$helper_ok" = "yes" ] && {
  echo "  ${GREEN}All checks passed.${NC} Enforcement is active. Try Grep(\"SomeSymbol\") to verify blocking."
  exit 0
}
echo "  ${RED}Issues detected.${NC} Re-run 'bash install.sh' to fix missing components."
exit 1
