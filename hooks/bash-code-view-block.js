#!/usr/bin/env node
'use strict';

// bash-code-view-block.js — PreToolUse hook (matcher: Bash)
//
// Closes a structural gap left by bash-grep-block.js (which only gates
// symbol *search*): a Bash command can view a code file's content —
// whole or by line range — without ever containing grep/rg/ag/ack or a
// regex-addressed sed/awk pattern, so it sails through untouched.
// lsp-bypass-handoff.md (cbc-mono, Cause 2c) documents 24 such calls
// across 3 real sessions — `sed -n 'N,Mp' file.go`,
// `awk '{print NR": "$0}' file.go`, bare `cat file.go`,
// `git show HEAD:file.go` — each functionally identical to a `Read` call
// but invisible to lsp-first-read-guard.js (which only fires on
// tool_name === 'Read') and its free-read/nav-count gate.
//
// This hook doesn't reimplement that gate — it redirects: any Bash
// command that VIEWS a range or whole content of a code file (no
// specific symbol target — that's bash-grep-block.js's job, and is
// exempted here to avoid double-blocking the same command) is blocked
// with "use Read instead", so the content flows through the one gate
// already built for it.
//
// Exempt: git diff / git log -p / git show <ref> [-- <path>] (no colon
// before the path) — these show only a diff or commit history, not the
// file's current full content, even when piped into sed/awk/head/tail
// for narrowing. Only `git show <ref>:<path>` (colon form — fetches the
// full file at that ref) is gated, since that IS a full-content fetch.
//
// Protocol: emits a structured `{decision:"block", ...}` JSON response
// (same protocol as the other hooks in this kit) rather than exit(2), so
// consumers reading blocking-hook output stay consistent across the kit.

const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|vue|svelte|cpp|c|h|hpp)$/i;
const ALLOW_NON_CODE_EXT = /\.(md|txt|log|json|jsonc|yaml|yml|env|csv|toml|xml|sql|sh|css|scss|html|lock|ini|conf|cfg)$/i;
const ALLOW_CONFIG_PATTERNS = /(\.config\.|tsconfig|next\.config|vite\.config|webpack\.config|rollup\.config|babel\.config|jest\.config|vitest\.config|tailwind\.config|postcss\.config|eslint|prettier|package\.json|pnpm-lock|yarn\.lock)/i;
const ALLOW_PATH_PATTERNS = /(^|\/)(\.task|\.claude|\.git|node_modules|build|dist|out|public|scripts|docs?|knowledge-vault|supabase\/migrations|coverage|\.next|\.turbo|__tests__|__mocks__)(\/|$)/i;
const ALLOW_TEST_PATTERNS = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;

// Extract every whitespace/quote-delimited token that looks like a path
// with a code extension, to check against the allow/deny path rules
// below. Not a shell parser — a best-effort scan, same spirit as
// bash-grep-block.js's own command inspection.
function codeFilePathsIn(cmd) {
  const tokens = cmd.match(/[^\s'"]+/g) || [];
  return tokens.filter(t => CODE_EXTENSIONS.test(t));
}

function isGatedCodePath(p) {
  if (ALLOW_NON_CODE_EXT.test(p)) return false;
  if (ALLOW_CONFIG_PATTERNS.test(p.split('/').pop())) return false;
  if (ALLOW_PATH_PATTERNS.test(p)) return false;
  if (ALLOW_TEST_PATTERNS.test(p)) return false;
  return CODE_EXTENSIONS.test(p);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }
  if (data.tool_name !== 'Bash') process.exit(0);

  const cmd = String(data.tool_input?.command ?? '').trim();
  if (!cmd) process.exit(0);

  const codePaths = codeFilePathsIn(cmd).filter(isGatedCodePath);
  if (codePaths.length === 0) process.exit(0);

  // Exempt: git diff / git log -p / git show <ref> (no colon before the
  // path) — diff/history review, not a full-content fetch.
  const isGitShowColon = /\bgit\s+show\s+[^\s:]+:\S+/.test(cmd);
  const isGitDiffOrLog = /\bgit\s+(diff|log)\b/.test(cmd) || (/\bgit\s+show\b/.test(cmd) && !isGitShowColon);
  if (isGitDiffOrLog) process.exit(0);

  const hasGrepToken = /\b(grep|rg|ag|ack)\b/i.test(cmd);

  // Numeric-address sed (sed -n 'N,Mp' / 'Np' / multiple ';'-separated
  // ranges) — regex-address sed ('/pattern/,/pattern/p') is
  // bash-grep-block.js's concern, not this hook's.
  const isSedRange = /\bsed\s+-n\s+['"]?(?:\d+(?:,\d+)?p;?\s*)+['"]?/.test(cmd);
  // awk referencing NR (the record-number builtin) is a strong signal of
  // line-oriented viewing, distinct from bash-grep-block.js's
  // regex-address awk detection ('/pattern/,/pattern/').
  const isAwkNR = /\bawk\b/i.test(cmd) && /\bNR\b/.test(cmd);
  // Bare cat on a code file — excluded when grep/rg/ag/ack is also
  // present (bash-grep-block.js already handles that shape), and when
  // cat's argument is a heredoc redirect (`cat <<'EOF'`) rather than a
  // file: that's a string-building idiom (e.g. this repo's own git-commit
  // instructions), not a file view, even if the heredoc body happens to
  // mention a filename with a code extension as plain text.
  const isBareCat = /\bcat\s+(?!<<)\S/.test(cmd) && !hasGrepToken && !/\bgit\s+show\b/.test(cmd);

  const isView = isGitShowColon || isSedRange || isAwkNR || isBareCat;
  if (!isView) process.exit(0);

  const files = codePaths.slice(0, 3).join(', ');
  process.stderr.write(
    `\n⛔ LSP-FIRST: Blocked — this Bash command views code-file content (${files}) the same way Read would, but bypasses its gate.\n` +
    `Use the Read tool instead — it's gated identically (free reads, then LSP navigation required).\n` +
    `Looking for a specific symbol rather than a line range? Use the native LSP tool (goToDefinition / findReferences / hover / documentSymbol).\n\n`
  );
  console.log(JSON.stringify({
    decision: 'block',
    reason: `LSP-FIRST: Bash command views code-file content (${files}) instead of using Read. Use Read (gated) or the native LSP tool for a specific symbol.`,
    hook: 'bash-code-view-block',
  }));
});

