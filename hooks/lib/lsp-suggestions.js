'use strict';

/**
 * lsp-suggestions.js — shared helper for LSP enforcement hooks
 *
 * Builds symbol-navigation suggestions for blocked Bash/Grep/Glob calls,
 * and warmup instructions for the Read gate — all pointed at Claude
 * Code's native `LSP` tool (operation-based: goToDefinition,
 * findReferences, hover, documentSymbol, workspaceSymbol,
 * goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls).
 *
 * No MCP server (cclsp, Serena, or any other mcp__*-namespaced LSP
 * implementation) is ever suggested, detected, or treated as a
 * substitute. This harness exposes LSP natively; there is no "provider"
 * to pick between, and none should be reintroduced here.
 */

const fs = require('fs');

// ── Native LSP operation map ────────────────────────────────────────────
// abstract intent → operation name(s) for Claude Code's built-in `LSP`
// tool (operation enum: goToDefinition, findReferences, hover,
// documentSymbol, workspaceSymbol, goToImplementation,
// prepareCallHierarchy, incomingCalls, outgoingCalls).
const NATIVE_OPERATIONS = {
  definition:      ['goToDefinition', 'documentSymbol'],
  references:      ['findReferences'],
  symbol_search:   ['workspaceSymbol'],
  implementation:  ['goToImplementation'],
  callsite:        ['incomingCalls'],
  hover:           ['hover'],
  outgoing_calls:  ['outgoingCalls'],
  // Any of these satisfies a bare (shape-ambiguous) identifier.
  bare:            ['goToDefinition', 'findReferences', 'goToImplementation', 'workspaceSymbol'],
};

// grep/glob/sed/awk-pattern shape → the native operation(s) required to
// satisfy it. Reuses the same operation lists as the suggestion intents
// above — one symbol classification, one source of truth for both the
// suggestion text and the enforcement check.
const REQUIRED_OPS_BY_SHAPE = {
  declaration: NATIVE_OPERATIONS.definition,
  callsite:    NATIVE_OPERATIONS.callsite,
  bare:        NATIVE_OPERATIONS.bare,
};

/**
 * Classify how `symbol` occurs in `rawText` (declaration-shaped,
 * call-site-shaped, or bare), given that `symbol` is already known to be
 * a plausible identifier. Used once a symbol has already been extracted
 * by a hook's own token-based logic.
 */
function classifySymbolShape(rawText, symbol) {
  const esc = String(symbol).replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m);
  if (new RegExp(`\\b(?:func|type|const|var|class|interface|struct)\\s+${esc}\\b`).test(rawText)) {
    return 'declaration';
  }
  if (new RegExp(`${esc}\\s*\\(`).test(rawText)) {
    return 'callsite';
  }
  return 'bare';
}

/**
 * Scan raw text (a shell command, a Grep/Glob pattern, a sed/awk address
 * expression — anything a hook has on hand) directly for a declaration-
 * or call-site-shaped symbol occurrence, independent of a hook's own
 * whitespace-sensitive token extraction. Multi-word forms like
 * `"func handleSubmit"` or `"type UserService struct"` contain a space
 * and would never survive a single-token bare-identifier extractor, so
 * this checks the whole string instead.
 *
 * `looksLikeSymbol` is the caller's own "is this a plausible identifier,
 * not a keyword/short word" predicate (each hook already has one) —
 * required so a bare `if (`/`for (`/`switch (` doesn't get misread as a
 * call-site.
 *
 * Returns { identifier, shape } or null.
 */
function findDeclarationOrCallsite(rawText, looksLikeSymbol) {
  const declMatch = rawText.match(/\b(?:func|type|const|var|class|interface|struct)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
  if (declMatch && looksLikeSymbol(declMatch[1])) {
    return { identifier: declMatch[1], shape: 'declaration' };
  }
  const callMatch = rawText.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (callMatch && looksLikeSymbol(callMatch[1])) {
    return { identifier: callMatch[1], shape: 'callsite' };
  }
  return null;
}

/**
 * True if a prior `LSP` tool call this session (per the transcript)
 * already satisfies `identifier` for one of `requiredOps`. A request
 * alone rarely carries the identifier (goToDefinition/findReferences/...
 * take a filePath+line+character, not a name), so this pairs each LSP
 * tool_use's id to its operation, then checks the paired tool_result's
 * content — plus the request itself, which covers workspaceSymbol's
 * `query` field.
 */
function isLspSatisfied(transcriptPath, identifier, requiredOps) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;

  const idToOperation = new Map();
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return false;
  }

  for (const raw of lines) {
    if (!raw.trim()) continue;
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'tool_use' && block.name === 'LSP') {
        const input = block.input || {};
        const op = input.operation;
        if (block.id) idToOperation.set(block.id, op);
        if (!requiredOps.includes(op)) continue;
        if (JSON.stringify(input).includes(identifier)) return true;
      } else if (block.type === 'tool_result') {
        const op = idToOperation.get(block.tool_use_id);
        if (op == null || !requiredOps.includes(op)) continue;
        const result = block.content;
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        if (resultStr.includes(identifier)) return true;
      }
    }
  }
  return false;
}

/**
 * Build a suggestion line for a given symbol and navigation intent,
 * pointed at the native `LSP` tool. Advisory phrasing, not a
 * copy-pasteable call: the native tool requires filePath/line/character
 * for every operation (even workspaceSymbol), data a grep/glob/sed
 * pattern match doesn't have.
 */
function buildSuggestion(symbol, intent, indent = '  ') {
  const ops = NATIVE_OPERATIONS[intent] || NATIVE_OPERATIONS.bare;
  return `${indent}LSP tool — operation: ${ops.join(' or ')} (for "${symbol}")`;
}

/**
 * Warmup instructions for Gate 1 in lsp-first-read-guard.js, with no
 * concrete file known yet.
 */
function buildWarmupInstructions(indent = '  ') {
  return [
    `${indent}LSP tool, operation "documentSymbol", on any project file.`,
    `${indent}  → lists the file's symbols and counts as warmup (position is ignored by this operation).`,
  ];
}

/**
 * Copy-pasteable warmup call parametrized by the actual file the agent
 * is about to Read — the one case where a concrete filePath IS known, so
 * a real call (not just advisory phrasing) can be given. documentSymbol
 * ignores line/character, so 1/1 is just an anchor value the schema
 * requires.
 */
function buildFileWarmupCall(filePath, indent = '  ') {
  if (!filePath) return '';
  const safeFile = String(filePath).replace(/"/g, '\\"');
  return `${indent}LSP tool: operation "documentSymbol", filePath "${safeFile}", line 1, character 1`;
}

/**
 * Build a structured suggestion object for programmatic consumers
 * (monitoring, dashboards, IDE plugins).
 */
function buildStructuredSuggestions(symbol, intent) {
  const ops = NATIVE_OPERATIONS[intent] || NATIVE_OPERATIONS.bare;
  return [{
    tool: 'LSP',
    operations: ops,
    query: String(symbol),
    displayTool: `LSP tool — operation: ${ops.join(' or ')} (for "${symbol}")`,
  }];
}

/**
 * Assemble a structured block response that blocking hooks can emit via
 * console.log(JSON.stringify(...)). Keeps `decision`/`reason` fields
 * intact (backward compatible with existing consumers).
 */
function buildStructuredBlockResponse({ hook, symbols, intent, reason }) {
  const suggestions = [];
  const symbolList = Array.isArray(symbols) ? symbols : [];
  for (const sym of symbolList) {
    for (const s of buildStructuredSuggestions(sym, intent)) {
      suggestions.push({ symbol: String(sym), ...s });
    }
  }
  return {
    decision: 'block',
    reason:   String(reason ?? ''),
    hook:     String(hook ?? ''),
    symbols:  symbolList.map(String),
    intent:   String(intent ?? ''),
    suggestions,
  };
}

module.exports = {
  NATIVE_OPERATIONS,
  REQUIRED_OPS_BY_SHAPE,
  classifySymbolShape,
  findDeclarationOrCallsite,
  isLspSatisfied,
  buildSuggestion,
  buildWarmupInstructions,
  buildFileWarmupCall,
  buildStructuredSuggestions,
  buildStructuredBlockResponse,
};
