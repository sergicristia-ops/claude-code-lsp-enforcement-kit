#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/hooks"
RULES_DIR="$CLAUDE_DIR/rules"
STATE_DIR="$CLAUDE_DIR/state"
SETTINGS="$CLAUDE_DIR/settings.json"

echo "=== LSP Enforcement Kit — Install ==="
echo ""

# 1. Create directories
mkdir -p "$HOOKS_DIR" "$HOOKS_DIR/lib" "$RULES_DIR" "$STATE_DIR"
echo "[1/4] Directories ready"

# 2. Copy hooks + shared lib + rule
cp "$SCRIPT_DIR/hooks/"*.js "$HOOKS_DIR/"
cp "$SCRIPT_DIR/hooks/lib/"*.js "$HOOKS_DIR/lib/"
cp "$SCRIPT_DIR/rules/lsp-first.md" "$RULES_DIR/"
echo "[2/4] Copied 8 hooks + lib + 1 rule"

# 3. Merge into settings.json (node for safe JSON manipulation)
node -e "
const fs = require('fs');
const path = '$SETTINGS';

let settings = {};
if (fs.existsSync(path)) {
  try { settings = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
}

// Enable plugin
if (!settings.enabledPlugins) settings.enabledPlugins = {};
settings.enabledPlugins['typescript-lsp@claude-plugins-official'] = true;

// Hook entries to add. LSP suggestions/tracking are native-only (no MCP
// server, ever — see hooks/lib/lsp-suggestions.js and the policy note in
// lsp-bypass-handoff.md).
const preToolUse = [
  { matcher: 'Grep', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/lsp-first-guard.js' }] },
  { matcher: 'Glob', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/lsp-first-glob-guard.js' }] },
  { matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/bash-grep-block.js' }] },
  { matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/bash-code-view-block.js' }] },
  { matcher: 'Read', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/lsp-first-read-guard.js' }] },
  { matcher: 'Agent', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/lsp-pre-delegation.js' }] },
];

const postToolUse = [
  {
    matcher: 'LSP',
    hooks: [{ type: 'command', command: 'node ~/.claude/hooks/lsp-usage-tracker.js' }],
  },
];

const sessionStart = [
  { matcher: 'true', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/lsp-session-reset.js' }] },
];

if (!settings.hooks) settings.hooks = {};
if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];

// Dedupe: skip if command already registered
function hasHook(arr, command) {
  return arr.some(entry =>
    entry.hooks && entry.hooks.some(h => h.command === command)
  );
}

// Migration: an install predating the native-LSP-only redesign registered
// lsp-usage-tracker.js under a matcher naming individual mcp__cclsp__*
// tools. That matcher never matches the native 'LSP' tool, so the tracker
// would silently stop firing. Fix the matcher in place rather than
// skipping (hasHook only dedupes by command, not matcher, so a plain
// re-run would never correct this on its own).
const trackerCommand = 'node ~/.claude/hooks/lsp-usage-tracker.js';
for (const entry of settings.hooks.PostToolUse) {
  if (entry.hooks && entry.hooks.some(h => h.command === trackerCommand) && entry.matcher !== 'LSP') {
    entry.matcher = 'LSP';
  }
}

for (const entry of preToolUse) {
  if (!hasHook(settings.hooks.PreToolUse, entry.hooks[0].command)) {
    settings.hooks.PreToolUse.push(entry);
  }
}

for (const entry of postToolUse) {
  if (!hasHook(settings.hooks.PostToolUse, entry.hooks[0].command)) {
    settings.hooks.PostToolUse.push(entry);
  }
}

for (const entry of sessionStart) {
  if (!hasHook(settings.hooks.SessionStart, entry.hooks[0].command)) {
    settings.hooks.SessionStart.push(entry);
  }
}

fs.writeFileSync(path, JSON.stringify(settings, null, 2));
"
echo "[3/4] settings.json updated (merged, not overwritten)"

# 4. Verify
echo "[4/4] Verifying..."
HOOKS_COUNT=$(ls "$HOOKS_DIR"/lsp-*.js "$HOOKS_DIR"/bash-grep-block.js "$HOOKS_DIR"/bash-code-view-block.js 2>/dev/null | wc -l | tr -d ' ')
RULE_OK=$( [ -f "$RULES_DIR/lsp-first.md" ] && echo "yes" || echo "no" )
PLUGIN_OK=$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$SETTINGS','utf8'));
  console.log(s.enabledPlugins?.['typescript-lsp@claude-plugins-official'] ? 'yes' : 'no');
")

echo ""
echo "  Hooks installed:  $HOOKS_COUNT/8"
echo "  Rule installed:   $RULE_OK"
echo "  Plugin enabled:   $PLUGIN_OK"
echo "  State directory:  $([ -d "$STATE_DIR" ] && echo 'yes' || echo 'no')"
echo ""

if [ "$HOOKS_COUNT" -eq 8 ] && [ "$RULE_OK" = "yes" ] && [ "$PLUGIN_OK" = "yes" ]; then
  echo "Done. Restart Claude Code to activate."
else
  echo "WARNING: Some components missing. Check output above."
fi
