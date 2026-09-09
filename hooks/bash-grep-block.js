#!/usr/bin/env node
'use strict';

// bash-grep-block.js — PreToolUse hook (matcher: Bash)
// Blocks grep/rg/ag/ack — and sed -n / awk address-range forms used the
// same way — when they target a code symbol in shell commands. Always
// suggests Claude Code's native LSP tool (no MCP server involved).
// Allows: git grep, non-code paths, non-code file types.

const { buildSuggestion, buildStructuredBlockResponse, classifySymbolShape, REQUIRED_OPS_BY_SHAPE, isLspSatisfied, findDeclarationOrCallsite } = require('./lib/lsp-suggestions');

// Zero-width / formatting chars that would split tokens invisibly and
// bypass ASCII regex symbol detection.
const ZERO_WIDTH = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g;

function looksLikeBareSymbol(p) {
  if (p.length < 4 || /\s/.test(p)) return false;
  const skip = [
    /^(TODO|FIXME|HACK|XXX|NOTE)/i,
    /^console\b/, /^import\b/, /^export\b/, /^http/i, /^\d/,
    /^[A-Z_]{3,}$/,
    /^[a-z]{1,8}$/,
    /^[a-z]+-[a-z]+/,
  ];
  if (skip.some(rx => rx.test(p))) return false;

  return (/^[a-z][a-zA-Z0-9]{3,}$/.test(p) && /[A-Z]/.test(p)) ||
         /^[A-Z][a-zA-Z][a-zA-Z0-9]{2,}$/.test(p) ||
         (/^[a-z]+(_[a-z]+){2,}$/.test(p) && p.length >= 9);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }
  if (data.tool_name !== 'Bash') process.exit(0);

  // String coercion: non-string command would throw on .trim() and fail-open.
  // Zero-width strip: prevents `grep​UserFunc` evasion.
  const cmd = String(data.tool_input?.command ?? '').trim().replace(ZERO_WIDTH, '');
  const transcriptPath = data.transcript_path || '';

  // Gate: grep/rg/ag/ack (existing), plus sed -n / awk address-range
  // forms used the same way to hunt a declaration or call-site (Cause 2b
  // in the lsp-bypass-handoff — `sed -n '/type Foo interface/,/^}/p'`
  // previously sailed through untouched since it never contains these
  // four tokens).
  const isSearchLike = /\b(grep|rg|ag|ack)\b/i.test(cmd) || /\bsed\s+-n\b/i.test(cmd) || /\bawk\b/i.test(cmd);
  if (!isSearchLike) process.exit(0);
  if (/\bgit\s+grep\b/i.test(cmd)) process.exit(0);
  if (/(?:^|[\/\\])(?:supabase[\/\\]migrations|\.task|\.claude|node_modules|knowledge-vault)(?:[\/\\]|$)/i.test(cmd)) process.exit(0);
  if (/--include=?\S*\.(sql|md|json|yaml|yml|txt|env|sh|css|scss|log)\b/i.test(cmd)) process.exit(0);

  const cleaned = cmd.replace(/\\"/g, '"');

  const grepPatternMatch =
    cleaned.match(/\b(?:grep|rg|ag|ack)\s+(?:-\S+\s+)*"([^"]+)"/i) ||
    cleaned.match(/\b(?:grep|rg|ag|ack)\s+(?:-\S+\s+)*'([^']+)'/i) ||
    cleaned.match(/\b(?:grep|rg|ag|ack)\s+(?:(?:-\w+\s+(?:[a-z]+\s+)?)*?)([A-Z][a-zA-Z]\w+)/i);

  // sed -n / awk quoted program — covers regex-address forms like
  // '/type Foo interface/,/^}/p' or '/handleSubmit(/,/^}/p'. Deliberately
  // the same broad capture regardless of whether the program is actually
  // a declaration/call-site hunt or a pure line-range/print program (the
  // latter falls through findDeclarationOrCallsite() below as no match —
  // pure line-range viewing is bash-code-view-block.js's job, not this
  // hook's).
  const sedAwkMatch =
    cleaned.match(/\b(?:sed\s+-n|awk)\s+"([^"]+)"/i) ||
    cleaned.match(/\b(?:sed\s+-n|awk)\s+'([^']+)'/i);

  let declOrCall = null;
  if (sedAwkMatch) declOrCall = findDeclarationOrCallsite(sedAwkMatch[1], looksLikeBareSymbol);
  if (!declOrCall && grepPatternMatch) declOrCall = findDeclarationOrCallsite(grepPatternMatch[1], looksLikeBareSymbol);

  if (!grepPatternMatch && !declOrCall) process.exit(0);

  const fullPattern = grepPatternMatch ? grepPatternMatch[1] : '';

  const cleanedParts = fullPattern
    ? fullPattern
        .split(/\\?\||\./)
        .map(p => p.replace(ZERO_WIDTH, '').replace(/[*+?^${}()[\]\\]/g, '').trim())
        .filter(Boolean)
    : [];
  const bareSymbols = cleanedParts.filter(looksLikeBareSymbol);

  const symbols = [...bareSymbols];
  if (declOrCall && !symbols.includes(declOrCall.identifier)) symbols.push(declOrCall.identifier);

  // SECURITY: only allow the safe-prefix pipe bypass AFTER confirming no code symbols.
  // Previously `echo x | grep SomeCamelFunc` passed because the bypass ran before
  // symbol detection. Now: if symbols present, no bypass — always proceed to block.
  if (symbols.length === 0) {
    const targetsCodeEarly =
      /\bsrc[\\/]|\bapp[\\/]|components[\\/]|lib[\\/]|hooks[\\/]|utils[\\/]|services[\\/]|actions[\\/]/i.test(cmd) ||
      /\.tsx?\b|\.jsx?\b/i.test(cmd);
    const hasNonCodeTargetEarly = /\.(sql|md|json|yaml|yml|txt|env|sh|css|scss|log|toml|xml)\b/i.test(cmd) && !targetsCodeEarly;
    if (hasNonCodeTargetEarly) process.exit(0);

    const isSimplePipe = /\|/.test(cmd) && !/xargs|exec/.test(cmd);
    const grepPos = cmd.search(/\b(grep|rg|ag|ack)\b/i);
    const pipePos = cmd.indexOf('|');
    if (isSimplePipe && pipePos !== -1 && pipePos < grepPos) {
      const beforePipe = cmd.substring(0, pipePos).trim();
      if (/^(git|npm|npx|pnpm|node|echo|cat\s+\S+\.(?:json|md|txt|log|ya?ml))/i.test(beforePipe) ||
          /^(ls|wc|head|tail|sort|uniq)\b/i.test(beforePipe)) {
        process.exit(0);
      }
    }
    process.exit(0);
  }

  const targetsCode =
    /\bsrc[\\/]|\bapp[\\/]|components[\\/]|lib[\\/]|hooks[\\/]|utils[\\/]|services[\\/]|actions[\\/]/i.test(cmd) ||
    /\.tsx?\b|\.jsx?\b/i.test(cmd) ||
    /-t\s+(ts|tsx|js|jsx|typescript|javascript)\b/i.test(cmd) ||
    /--type[= ](ts|tsx|js|jsx|typescript)\b/i.test(cmd) ||
    /\bfind\b.*\b(src|app|components|lib)\b/.test(cmd) ||
    /\bxargs\b.*\b(grep|rg|ag|ack)\b/i.test(cmd) ||
    /-exec\s+(grep|rg|ag|ack)\b/i.test(cmd);

  const hasNonCodeTarget =
    /\.(sql|md|json|yaml|yml|txt|env|sh|css|scss|log|toml|xml)\b/i.test(cmd) &&
    !targetsCode;

  // Symbols are present — only bypass if the command is unambiguously
  // targeting non-code files AND doesn't touch code paths.
  if (hasNonCodeTarget && !targetsCode) process.exit(0);

  // Shape-based enforcement: classify each symbol's occurrence in the raw
  // command (declaration-shaped, call-site-shaped, or bare) and check
  // whether a prior LSP call this session already satisfies it. Only
  // block symbols that still need one.
  function intentForShape(shape, sym) {
    if (shape === 'declaration') return 'definition';
    if (shape === 'callsite') return 'callsite';
    return /^[A-Z]/.test(sym) ? 'symbol_search' : 'references';
  }

  const unsatisfied = symbols.filter(sym => {
    const shape = classifySymbolShape(cmd, sym);
    return !isLspSatisfied(transcriptPath, sym, REQUIRED_OPS_BY_SHAPE[shape]);
  });
  if (unsatisfied.length === 0) process.exit(0);

  const suggestions = unsatisfied.map(sym => {
    const intent = intentForShape(classifySymbolShape(cmd, sym), sym);
    return `  ${sym}:\n${buildSuggestion(sym, intent, '    ')}`;
  }).join('\n');

  process.stderr.write(
    `\n⛔ LSP-FIRST: Blocked — found ${unsatisfied.length} code symbol(s) needing LSP: ${unsatisfied.join(', ')}\n` +
    `LSP is always connected (native tool — no MCP server needed). Use:\n${suggestions}\n\n`
  );

  const intent = intentForShape(classifySymbolShape(cmd, unsatisfied[0]), unsatisfied[0]);
  console.log(JSON.stringify(buildStructuredBlockResponse({
    hook: 'bash-grep-block',
    symbols: unsatisfied,
    intent,
    reason: `LSP-FIRST: Pattern contains code symbols [${unsatisfied.join(', ')}]. Use LSP:\n${suggestions}`,
  })));
});
