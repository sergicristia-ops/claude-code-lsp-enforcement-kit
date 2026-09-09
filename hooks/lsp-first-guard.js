#!/usr/bin/env node
'use strict';

// lsp-first-guard.js — PreToolUse hook (matcher: Grep)
// Blocks Grep on code symbols. Always suggests Claude Code's native LSP
// tool (no MCP server involved).

const { buildSuggestion, buildStructuredBlockResponse, classifySymbolShape, REQUIRED_OPS_BY_SHAPE, isLspSatisfied, findDeclarationOrCallsite } = require('./lib/lsp-suggestions');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(raw); } catch (e) { process.exit(0); }

  if (data.tool_name !== 'Grep') process.exit(0);

  const params  = data.tool_input || {};
  // String coercion: non-string pattern (number, array, etc.) would throw on .trim()
  // and fail-open — Claude Code treats crash as passthrough. See security review.
  const pattern = String(params.pattern ?? '').trim();
  const searchPath = String(params.path ?? '');
  const glob    = String(params.glob ?? '');
  const transcriptPath = data.transcript_path || '';

  if (/knowledge-vault|\.task[\\/]|\.claude[\\/]|node_modules|logs?[\\/]|docs?[\\/]|supabase[\\/]migrations/i.test(searchPath)) {
    process.exit(0);
  }

  if (/\.(md|txt|log|json|jsonc|yaml|yml|env|csv|toml|xml|sql|sh|css|scss)/i.test(glob)) {
    process.exit(0);
  }

  if (pattern.length < 4) process.exit(0);

  const parts = pattern.split('|').map(p => p.trim()).filter(Boolean);
  const symbolParts = [];
  for (const part of parts) {
    if (isCodeSymbol(part)) symbolParts.push(part);
  }

  // Whole-string pre-check: catches multi-word declaration forms (e.g.
  // "func handleSubmit", "type UserService struct") that the `|`-split
  // token extraction above can't see, since isCodeSymbol() rejects any
  // token containing whitespace.
  const declOrCall = findDeclarationOrCallsite(pattern, isCodeSymbol);
  if (declOrCall && !symbolParts.includes(declOrCall.identifier)) {
    symbolParts.push(declOrCall.identifier);
  }

  if (symbolParts.length === 0) process.exit(0);

  function intentForShape(shape, sym) {
    if (shape === 'declaration') return 'definition';
    if (shape === 'callsite') return 'callsite';
    return /^[A-Z]/.test(sym) ? 'symbol_search' : 'references';
  }

  // Shape-based enforcement: only block symbols not already satisfied by
  // a prior LSP call this session.
  const unsatisfied = symbolParts.filter(sym => {
    const shape = classifySymbolShape(pattern, sym);
    return !isLspSatisfied(transcriptPath, sym, REQUIRED_OPS_BY_SHAPE[shape]);
  });
  if (unsatisfied.length === 0) process.exit(0);

  const suggestions = unsatisfied.map(sym => {
    const intent = intentForShape(classifySymbolShape(pattern, sym), sym);
    return `  ${sym}:\n${buildSuggestion(sym, intent, '    ')}`;
  }).join('\n');

  process.stderr.write(
    `\n⛔ LSP-FIRST BLOCK: ${unsatisfied.length} code symbol(s) in Grep needing LSP\n` +
    `Symbols: ${unsatisfied.join(', ')}\nLSP tools:\n${suggestions}\n\n`
  );

  // Emit structured JSON for programmatic consumers (monitoring, dashboards, IDE plugins).
  // `decision` and `reason` fields remain backward compatible.
  const intent = intentForShape(classifySymbolShape(pattern, unsatisfied[0]), unsatisfied[0]);
  console.log(JSON.stringify(buildStructuredBlockResponse({
    hook: 'lsp-first-guard',
    symbols: unsatisfied,
    intent,
    reason: `LSP-FIRST: Pattern contains code symbol(s) [${unsatisfied.join(', ')}]. Use LSP tools:\n${suggestions}`,
  })));
});

function isCodeSymbol(s) {
  if (s.length < 4) return false;
  if (/\s/.test(s)) return false;
  if (/[&?+[\]{}()\\^$*]/.test(s)) return false;

  const allowList = [
    /^(TODO|FIXME|HACK|XXX|NOTE)/i,
    /^console\./, /^import\b/, /^require\(/, /^from\b/, /^export\b/,
    /^\/\//, /^#/, /^\./, /^http/i, /^\d/,
    /^[A-Z_]{3,}$/,
    /^[a-z]{1,8}$/,
    /^['"`]/,
    /^use (client|server)/,
  ];
  if (allowList.some(rx => rx.test(s))) return false;

  if (/^[a-z]+-[a-z]/.test(s)) {
    if (/^(text-|bg-|border-|font-|hover:|focus:|active:|group-|ring-|shadow-|rounded-|flex-|grid-|gap-|space-|divide-|overflow-|whitespace-|break-|leading-|tracking-|align-|justify-|items-|self-|order-|col-|row-|transition-|duration-|ease-|animate-|scale-|rotate-|translate-|origin-|cursor-|select-|resize-|appearance-|outline-|decoration-|underline-|line-|placeholder-|caret-|accent-|sr-|z-|opacity-|w-|h-|p-|m-|px-|py-|pt-|pb-|pl-|pr-|mx-|my-|mt-|mb-|ml-|mr-|max-|min-|inset-|top-|right-|bottom-|left-|float-|data-)/.test(s)) {
      return false;
    }
    if (/-(modal|form|dialog|sidebar|popover|tab|list|card|button|widget|table|page|layout|header|footer|section|panel|gallery|grid|menu|nav|banner|badge|skeleton|spinner|tooltip|dropdown|select|input|textarea|checkbox|radio|switch|slider|avatar|icon|chip|toast|alert|bar|row|cell|item|field|wrapper|container|provider|context|hook|view|screen|chart|editor|builder|filler|picker|uploader|timeline|breadcrumb|steward|runner|tester|checker|resolver|reviewer|optimizer|detector|guard|enforcer)s?$/.test(s)) {
      return true;
    }
    if (/^(actions?|helpers?|utils?|hooks?|types?|constants?|validations?|services?)-/.test(s)) {
      return true;
    }
    return false;
  }

  const isCamelCase = /^[a-z][a-zA-Z0-9]{3,}$/.test(s) && /[A-Z]/.test(s);
  const isPascalCase = /^[A-Z][a-zA-Z][a-zA-Z0-9]{2,}$/.test(s);
  const isDottedSymbol = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/i.test(s);
  const isSnakeCaseFunc = /^[a-z]+(_[a-z]+){2,}$/.test(s) && s.length >= 9;

  return isCamelCase || isPascalCase || isDottedSymbol || isSnakeCaseFunc;
}
