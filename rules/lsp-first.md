# LSP-First Navigation (CRITICAL)

ALL agents MUST use Claude Code's native `LSP` tool for semantic
navigation — never Grep/Glob/Bash to search for a code symbol, and never
an MCP server (cclsp, Serena, or otherwise). The `LSP` tool is built in;
there is nothing to install or connect.

Call it with `operation` set to one of:

| Task | `LSP` operation |
|------|-----------------|
| Where is this defined? | `goToDefinition` (or `documentSymbol` if you already have the file open) |
| Who references/calls this? | `findReferences` |
| Search by name across the codebase | `workspaceSymbol` |
| Interface implementations | `goToImplementation` |
| Who calls this function? (impact analysis) | `prepareCallHierarchy` then `incomingCalls` |
| What does this function call? | `prepareCallHierarchy` then `outgoingCalls` |
| Type info / docs at a position | `hover` |
| List a file's symbols | `documentSymbol` |

This is enforced, not just preferred: this kit's hooks actively block a
Grep/Glob/Bash search once it looks like a symbol lookup (declaration-
shaped, call-site-shaped, or a bare identifier), and separately block
viewing a code file's content via Bash (`sed`/`awk`/`cat`/`git show
<ref>:<path>`) in place of `Read`. Grep/Glob/Bash text search stays fine
for genuinely non-symbol content — TODO/comment text, config files,
route strings, `git diff`/`git log -p` review — never for "find where X
is defined" or "who calls X."
