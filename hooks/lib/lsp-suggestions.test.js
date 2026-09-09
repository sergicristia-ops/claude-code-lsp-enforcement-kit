'use strict';

/**
 * Plain-assert smoke tests for lsp-suggestions.js.
 * Run with: node hooks/lib/lsp-suggestions.test.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const MODULE_PATH = path.join(__dirname, 'lsp-suggestions.js');
const lib = require(MODULE_PATH);

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.log(`FAIL: ${name}`);
    console.log(`  ${err.message}`);
    process.exitCode = 1;
  }
}

// ── No MCP, ever ────────────────────────────────────────────────────────────
// Policy (lsp-bypass-handoff.md, cbc-mono): no MCP server — cclsp, Serena,
// or otherwise — is ever suggested. This module has no provider registry,
// no mcpServers detection, nothing mcp__*-namespaced. These tests assert
// that absence directly, so a future edit can't quietly reintroduce it.

test('buildSuggestion never mentions MCP, cclsp, or Serena', () => {
  const out = lib.buildSuggestion('UserService', 'symbol_search', '  ');
  assert.doesNotMatch(out, /mcp__|cclsp|serena|MCP/i);
  assert.match(out, /LSP tool/);
});

test('buildWarmupInstructions never mentions MCP, cclsp, or Serena', () => {
  const out = lib.buildWarmupInstructions('  ').join('\n');
  assert.doesNotMatch(out, /mcp__|cclsp|serena|MCP|install/i);
});

test('buildFileWarmupCall never mentions MCP, cclsp, or Serena', () => {
  const out = lib.buildFileWarmupCall('src/page.tsx', '  ');
  assert.doesNotMatch(out, /mcp__|cclsp|serena|MCP/i);
  assert.match(out, /documentSymbol/);
});

test('buildStructuredBlockResponse suggestions are all tool "LSP", never an mcp__ tool name', () => {
  const resp = lib.buildStructuredBlockResponse({
    hook: 'test', symbols: ['UserService', 'handleSubmit'], intent: 'symbol_search', reason: 'r',
  });
  assert.equal(resp.suggestions.length, 2);
  for (const s of resp.suggestions) {
    assert.equal(s.tool, 'LSP');
    assert.doesNotMatch(JSON.stringify(s), /mcp__/i);
  }
});

test('module exports nothing provider-shaped (no PROVIDERS, detectProviders, isLspProviderTool)', () => {
  assert.equal(lib.PROVIDERS, undefined);
  assert.equal(lib.detectProviders, undefined);
  assert.equal(lib.isLspProviderTool, undefined);
  assert.equal(lib.getTrackerToolNameRegex, undefined);
});

// ── buildSuggestion: intent → native operation ─────────────────────────────

test('buildSuggestion maps each intent to the right native operation', () => {
  assert.match(lib.buildSuggestion('x', 'symbol_search', ''), /workspaceSymbol/);
  assert.match(lib.buildSuggestion('x', 'references', ''), /findReferences/);
  assert.match(lib.buildSuggestion('x', 'implementation', ''), /goToImplementation/);
  assert.match(lib.buildSuggestion('x', 'callsite', ''), /incomingCalls/);
  assert.match(lib.buildSuggestion('x', 'definition', ''), /goToDefinition/);
});

// ── classifySymbolShape ─────────────────────────────────────────────────────

test('classifySymbolShape recognizes a declaration-shaped occurrence', () => {
  assert.equal(lib.classifySymbolShape('grep -rn "func handleSubmit" .', 'handleSubmit'), 'declaration');
  assert.equal(lib.classifySymbolShape('type UserService struct {}', 'UserService'), 'declaration');
});

test('classifySymbolShape recognizes a call-site-shaped occurrence', () => {
  assert.equal(lib.classifySymbolShape('grep -rn "handleSubmit(" .', 'handleSubmit'), 'callsite');
});

test('classifySymbolShape falls back to bare for an ambiguous occurrence', () => {
  assert.equal(lib.classifySymbolShape('grep -rn "handleSubmit" .', 'handleSubmit'), 'bare');
});

test('REQUIRED_OPS_BY_SHAPE maps each shape to the right native operation(s)', () => {
  assert.deepEqual(lib.REQUIRED_OPS_BY_SHAPE.declaration, ['goToDefinition', 'documentSymbol']);
  assert.deepEqual(lib.REQUIRED_OPS_BY_SHAPE.callsite, ['incomingCalls']);
  assert.deepEqual(lib.REQUIRED_OPS_BY_SHAPE.bare, ['goToDefinition', 'findReferences', 'goToImplementation', 'workspaceSymbol']);
});

// ── findDeclarationOrCallsite: whole-string pre-check ──────────────────────
// Ported to close the gap documented in lsp-bypass-handoff.md (session
// c4724c36 L989/L1002 and others): multi-word declaration forms like
// `"func handleSubmit"` or `"type UserService struct"` contain a space and
// never survive a hook's own single-token bare-identifier extractor.

const isPlausibleIdentifier = (s) => /^[A-Za-z][A-Za-z0-9]{3,}$/.test(s) && /[A-Z]/.test(s.slice(1)) || /^[A-Z][a-zA-Z0-9]{3,}$/.test(s);

test('findDeclarationOrCallsite finds a Go-style func declaration', () => {
  const r = lib.findDeclarationOrCallsite('grep -n "func validateAccess" resolver.go', isPlausibleIdentifier);
  assert.deepEqual(r, { identifier: 'validateAccess', shape: 'declaration' });
});

test('findDeclarationOrCallsite finds a type/struct/interface declaration', () => {
  const r = lib.findDeclarationOrCallsite("sed -n '/type TopupAPIClient interface/,/^}/p' resolver.go", isPlausibleIdentifier);
  assert.deepEqual(r, { identifier: 'TopupAPIClient', shape: 'declaration' });
});

test('findDeclarationOrCallsite finds a call-site', () => {
  const r = lib.findDeclarationOrCallsite('grep -n "CbcInitiatePayment(ctx" generated.go', isPlausibleIdentifier);
  assert.deepEqual(r, { identifier: 'CbcInitiatePayment', shape: 'callsite' });
});

test('findDeclarationOrCallsite rejects a generic keyword call like "if ("', () => {
  const r = lib.findDeclarationOrCallsite('grep -n "if (foo) {" main.go', isPlausibleIdentifier);
  assert.equal(r, null);
});

test('findDeclarationOrCallsite returns null when looksLikeSymbol rejects the match', () => {
  const r = lib.findDeclarationOrCallsite('grep -n "func Test" resolver_test.go', () => false);
  assert.equal(r, null);
});

// ── isLspSatisfied ──────────────────────────────────────────────────────────

function withTranscript(lines, fn) {
  const tmpFile = path.join(os.tmpdir(), `lsp-transcript-test-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(tmpFile, lines.map(JSON.stringify).join('\n'));
  try {
    return fn(tmpFile);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

test('isLspSatisfied is false with no transcript', () => {
  assert.equal(lib.isLspSatisfied('', 'UserService', ['workspaceSymbol']), false);
});

test('isLspSatisfied is true when a matching LSP tool_use carries the identifier (workspaceSymbol query)', () => {
  const satisfied = withTranscript(
    [{ message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'LSP', input: { operation: 'workspaceSymbol', filePath: 'a.ts', line: 1, character: 1, query: 'UserService' } }] } }],
    (transcriptPath) => lib.isLspSatisfied(transcriptPath, 'UserService', ['workspaceSymbol']),
  );
  assert.equal(satisfied, true);
});

test('isLspSatisfied is true when the identifier appears only in the paired tool_result', () => {
  const satisfied = withTranscript(
    [
      { message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'LSP', input: { operation: 'findReferences', filePath: 'a.ts', line: 10, character: 5 } }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'Found 3 references to handleSubmit in form-actions.ts' }] } },
    ],
    (transcriptPath) => lib.isLspSatisfied(transcriptPath, 'handleSubmit', ['findReferences']),
  );
  assert.equal(satisfied, true);
});

test('isLspSatisfied is false when the operation does not match the required set', () => {
  const satisfied = withTranscript(
    [
      { message: { content: [{ type: 'tool_use', id: 'tu_3', name: 'LSP', input: { operation: 'hover', filePath: 'a.ts', line: 10, character: 5 } }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'tu_3', content: 'handleSubmit: (e: Event) => void' }] } },
    ],
    (transcriptPath) => lib.isLspSatisfied(transcriptPath, 'handleSubmit', ['findReferences']),
  );
  assert.equal(satisfied, false);
});

test('isLspSatisfied is false when the identifier never appears', () => {
  const satisfied = withTranscript(
    [
      { message: { content: [{ type: 'tool_use', id: 'tu_4', name: 'LSP', input: { operation: 'findReferences', filePath: 'a.ts', line: 10, character: 5 } }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'tu_4', content: 'Found 0 references' }] } },
    ],
    (transcriptPath) => lib.isLspSatisfied(transcriptPath, 'someOtherSymbol', ['findReferences']),
  );
  assert.equal(satisfied, false);
});

test('isLspSatisfied ignores a non-LSP tool_use (e.g. an mcp__ tool would not satisfy anything)', () => {
  const satisfied = withTranscript(
    [
      { message: { content: [{ type: 'tool_use', id: 'tu_5', name: 'mcp__cclsp__find_references', input: { query: 'handleSubmit' } }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'tu_5', content: 'Found 3 references to handleSubmit' }] } },
    ],
    (transcriptPath) => lib.isLspSatisfied(transcriptPath, 'handleSubmit', ['findReferences']),
  );
  assert.equal(satisfied, false);
});
