<h1 align="center">LSP Enforcement Kit</h1>

<p align="center">
  <strong>Physical enforcement of LSP-first navigation in Claude Code.</strong>
  <br>
  Stop burning tokens on Grep. Make Claude navigate code like an IDE — 100% of the time.
</p>

<p align="center">
  <a href="https://github.com/nesaminua/claude-code-lsp-enforcement-kit/releases"><img src="https://img.shields.io/github/v/release/nesaminua/claude-code-lsp-enforcement-kit?style=for-the-badge&color=6366f1" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/nesaminua/claude-code-lsp-enforcement-kit?style=for-the-badge&color=10b981" alt="License"></a>
  <a href="https://github.com/nesaminua/claude-code-lsp-enforcement-kit/stargazers"><img src="https://img.shields.io/github/stars/nesaminua/claude-code-lsp-enforcement-kit?style=for-the-badge&color=f59e0b" alt="Stars"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-compatible-8b5cf6?style=for-the-badge" alt="Claude Code compatible">
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> &bull;
  <a href="#-the-problem">Why</a> &bull;
  <a href="#-token-savings-grep-vs-lsp-per-operation">Savings</a> &bull;
  <a href="#-architecture-7-hooks--1-tracker">Architecture</a> &bull;
  <a href="#-how-each-hook-works">Hooks</a> &bull;
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img src="assets/token-savings.png" alt="LSP vs Grep token savings — 73% per week" width="720">
</p>

---

## In Action

When Claude tries to `Grep` for a code symbol, the hook blocks and names the exact `LSP` operation the shape of that pattern calls for:

```
⛔ LSP-FIRST BLOCK: 2 code symbol(s) in Grep needing LSP
Symbols: handleSubmit, UserService
LSP tools:
  handleSubmit:
    LSP tool — operation: findReferences (for "handleSubmit")

  UserService:
    LSP tool — operation: workspaceSymbol (for "UserService")
```

A declaration- or call-site-shaped pattern gets an even more specific answer — `grep "func handleSubmit"` and `grep "handleSubmit("` don't get the same suggestion:

```
⛔ LSP-FIRST: Blocked — found 1 code symbol(s) needing LSP: handleSubmit
LSP is always connected (native tool — no MCP server needed). Use:
  handleSubmit:
    LSP tool — operation: goToDefinition or documentSymbol (for "handleSubmit")
```

When Claude tries to `Read` a code file without warming up LSP, the progressive gate blocks:

```
🛡️  LSP-FIRST READ GATE — Gate 1: warmup required

  Preferred: LSP tool, operation "documentSymbol", on any project file.
    → lists the file's symbols and counts as warmup (position is ignored by this operation).

  CONCRETE CALL FOR THIS FILE (works in any project):
    LSP tool: operation "documentSymbol", filePath "src/page.tsx", line 1, character 1

  After warmup: 2 free Reads, then need LSP navigation.
```

And when Claude tries to route around both of those with `sed`/`awk`/`cat`/`git show` instead of `Read`:

```
⛔ LSP-FIRST: Blocked — this Bash command views code-file content (src/page.tsx) the same way Read would, but bypasses its gate.
Use the Read tool instead — it's gated identically (free reads, then LSP navigation required).
```

No generic advice, no MCP server to install — every suggestion points at Claude Code's own built-in `LSP` tool, parametrized by the actual symbol or file Claude tried to touch.

---

## ⚡ Quick Start

**1. Have a language server for your language.** For TypeScript/JavaScript that's `typescript` itself (`tsserver` ships with it) — `npm install typescript` in the project, or have it available globally. For other languages, see [Other Languages](#-other-languages-python-go-rust) below (`gopls` for Go, `pylsp`/`pyright` for Python, `rust-analyzer` for Rust, …).

**2. Enable the plugin that wires that server into Claude Code's native LSP client.** For TS/JS this is the `typescript-lsp@claude-plugins-official` plugin — step 4 below (`install.sh`) enables it for you. For another language, follow Claude Code's own docs for configuring a language server; this kit doesn't change based on which one is active.

**3. Set the two env vars this kit's enforcement depends on**, in `~/.claude/settings.json` (or your project's) — `install.sh` does **not** set these for you, add them yourself:

```json
{
  "env": {
    "ENABLE_LSP_TOOL": "1",
    "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1"
  }
}
```

- **`ENABLE_LSP_TOOL`** turns on Claude Code's native `LSP` tool at all. Without it there's nothing for this kit's hooks to point Claude toward — every suggestion in this README assumes the tool exists.
- **`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`** is what gives *delegated subagents* LSP access. Claude Code can run an `Agent` call as a background task, and the `LSP` tool isn't available inside that execution mode — a subagent with no `LSP` tool to call falls straight back to Grep+Read, with no way to satisfy this kit's enforcement (see `lsp-pre-delegation.js` below). Setting this forces subagents to run in the foreground instead, where `LSP` is actually reachable.

**4. Install the hooks:**

```bash
git clone https://github.com/nesaminua/claude-code-lsp-enforcement-kit.git
cd claude-code-lsp-enforcement-kit
bash install.sh
# Windows: pwsh ./install.ps1
```

**5. Restart Claude Code.** Done. The installer is idempotent — safe to re-run on upgrades.

Verify:

```bash
bash scripts/lsp-status.sh
```

---

## 🎯 The Problem

Claude Code defaults to **Grep + Read** for code navigation. This works, but it's wasteful:

```
"Where is handleSubmit defined?"

Grep approach:
  Grep("handleSubmit") → 23 matches, ~1500 tokens of output
  Read file1.tsx (wrong) → 2500 tokens
  Read file2.tsx (still wrong) → 2500 tokens
  Read file3.tsx (found it) → 2500 tokens
  ─────────────────────────────────────
  Total: ~9,000 tokens, 4 tool calls

LSP approach:
  LSP goToDefinition on handleSubmit → form-actions.ts:42, ~80 tokens
  Read form-actions.ts:35-55 → ~150 tokens
  ─────────────────────────────────────
  Total: ~230 tokens, 2 tool calls
```

**~40x fewer tokens. Same answer.**

A rule in CLAUDE.md saying "use LSP" helps ~60% of the time. Hooks make it 100%.

## 💰 Token Savings: Grep vs LSP Per Operation

| Task | Grep approach | LSP approach | Saved |
|------|--------------|--------------|-------|
| Find definition of `handleSubmit` | Grep → 23 matches (~1500 tok) + 2 wrong Reads (~5000 tok) = **~6500 tok** | `goToDefinition` → file:line (~80 tok) + 1 targeted Read (~500 tok) = **~580 tok** | **91%** |
| Find all usages of `UserService` | Grep → 15 matches (~1200 tok), scan results (~300 tok) = **~1500 tok** | `findReferences` → 8 file:line pairs (~150 tok) = **~150 tok** | **90%** |
| Check type of `formData` | Read full file (~2500 tok), search visually = **~2500 tok** | `hover` → type signature (~60 tok) = **~60 tok** | **98%** |
| Find component `InviteForm` | Glob (~200 tok) + Grep (~800 tok) + Read wrong file (~2500 tok) = **~3500 tok** | `workspaceSymbol` → exact location (~100 tok) = **~100 tok** | **97%** |
| Who calls `validateToken`? | Grep → noisy results (~1500 tok) + 3 Reads to verify (~6000 tok) = **~7500 tok** | `prepareCallHierarchy` + `incomingCalls` → caller list (~200 tok) + 1 Read (~500 tok) = **~700 tok** | **91%** |

## 📊 Real-World Data: 1 Week, 2 Projects

Aggregate from a week of development across 2 TypeScript projects:

| Metric | With LSP | Without LSP (estimated) |
|--------|----------|------------------------|
| LSP navigation calls | 39 | — |
| Grep calls on code symbols | 0 (blocked) | ~120 |
| Unique code files Read | 53 | ~180 |
| Estimated navigation tokens | **~85k** | **~320k** |
| **Tokens saved** | | **~235k (~73%)** |

**How the estimate works:**
- Each blocked Grep saves ~1200 tokens of noisy output
- Each avoided Read saves ~1500 tokens of file content loaded into context
- 39 LSP calls cost ~4k tokens total (precise, compact results)
- Without LSP: ~120 Greps + ~180 Reads = ~315k tokens for the same navigation work
- With LSP: 39 nav calls + 53 targeted Reads = ~84k tokens

## 🔌 Native LSP only — no MCP server, ever

Every suggestion this kit makes points at Claude Code's **built-in `LSP` tool** — the one exposed natively by the harness (`operation`: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`). There is nothing to install, connect, or detect: it's either wired up for the file's language or the call errors out, same as any other tool.

Earlier versions of this kit suggested MCP LSP servers (cclsp, Serena) instead, with provider-detection logic to pick between them. That's gone as of this version — no MCP server is ever suggested, and none is required. `hooks/lib/lsp-suggestions.js` has no provider registry to configure; it just maps a navigation intent (or a detected declaration/call-site/bare symbol shape) straight to the matching native operation.

Language support is whatever Claude Code itself has a language server wired up for (TypeScript/JavaScript out of the box via the `typescript-lsp` plugin this kit enables — see [Installation](#-installation)). Consult Claude Code's own docs for adding a language server for another language; this kit doesn't change based on which one is active.

## 🏗️ Architecture: 7 Hooks + 1 Tracker

```
                    PreToolUse                          PostToolUse
                    ──────────                          ───────────

 Grep call ──→ [lsp-first-guard.js] ──→ BLOCK
                  detects code symbols (incl. multi-word
                  declaration/call-site shapes), suggests
                  the exact LSP operation for that shape

 Glob call ──→ [lsp-first-glob-guard.js] ──→ BLOCK
                  blocks *UserService*, **/handleFoo*.ts;
                  allows *.ts, *subdomain*, src/**

 Bash(grep) ──→ [bash-grep-block.js] ──→ BLOCK
                  catches grep/rg/ag/ack, plus
                  regex-address sed -n / awk (symbol hunts)

 Bash(sed/cat) → [bash-code-view-block.js] ──→ BLOCK
                  catches sed -n 'N,Mp' / awk NR-print /
                  bare cat / git show <ref>:<path> — viewing
                  a code file without going through Read
                  (git diff / git log -p stay exempt)

 Read(.tsx) ──→ [lsp-first-read-guard.js] ──→ GATE
                  5 progressive gates
                  (warmup → orient → nav → surgical)

 Agent(impl) ─→ [lsp-pre-delegation.js] ──→ BLOCK
                  subagents get no LSP tool access,
                  orchestrator must pre-resolve

 LSP call ─────────────────────────────────────→ [lsp-usage-tracker.js]
                                                   tracks nav_count,
                                                   read_count, state

                    SessionStart
                    ────────────

 New session ──→ [lsp-session-reset.js] ──→ WIPE
                    clears stale nav_count for current cwd,
                    forces fresh warmup + re-enforces gates
```

> **Note:** this kit's suggestions and enforcement are native-LSP-only —
> no MCP server (cclsp, Serena, or otherwise) is ever suggested or
> required (see "Native LSP only" above). It also closes two structural
> gaps documented against real
> bypass sessions: (1) a symbol-shaped `sed -n`/`awk` pattern used the
> same way `grep` would be, and (2) `sed`/`awk`/`cat`/`git show` used to
> view a code file's content in place of `Read`, both invisible to
> earlier versions since neither ever contained `grep`/`rg`/`ag`/`ack`.
> If you're upgrading, re-run `bash install.sh` — it's idempotent and
> also migrates the `PostToolUse` tracker matcher in place if it still
> targets the old `mcp__cclsp__*` tool names.

## 🔧 How Each Hook Works

### 1. `lsp-first-guard.js` — Grep Blocker

**Hook type:** PreToolUse | **Matcher:** `Grep`

Intercepts every Grep call. Detects code symbols in the pattern — including multi-word declaration (`func handleSubmit`, `type UserService struct`) and call-site (`handleSubmit(`) shapes that a plain single-token extractor would miss — and blocks with the exact `LSP` operation that shape calls for. If a prior `LSP` call this session already satisfies the symbol (checked against the transcript), the call is let through instead of blocked again.

| Pattern | Detected as | Action |
|---------|------------|--------|
| `getUserById` | camelCase symbol (bare) | BLOCK — `goToDefinition`/`findReferences`/`goToImplementation`/`workspaceSymbol` |
| `UserService` | PascalCase symbol (bare) | BLOCK — same as above |
| `func handleSubmit` / `type UserService struct` | declaration-shaped | BLOCK — `goToDefinition` or `documentSymbol` |
| `handleSubmit(` | call-site-shaped | BLOCK — `prepareCallHierarchy` then `incomingCalls` |
| `router.refresh` | dotted symbol | BLOCK |
| `write_audit_log` | snake_case function | BLOCK |
| `create-folder-modal` | component filename | BLOCK |
| `TODO` | keyword | allow |
| `NEXT_PUBLIC_URL` | env var (SCREAMING_SNAKE) | allow |
| `flex-col` | CSS class | allow |
| `*.md`, `*.json`, `*.sql` | non-code file glob | allow |
| `.task/`, `node_modules/` | non-code path | allow |

**Block message example:**
```
⛔ LSP-FIRST BLOCK: 1 code symbol(s) in Grep needing LSP
Symbols: handleSubmit
LSP tools:
  handleSubmit:
    LSP tool — operation: findReferences (for "handleSubmit")
```

### 2. `lsp-first-glob-guard.js` — Glob Symbol Blocker

**Hook type:** PreToolUse | **Matcher:** `Glob`

Closes the gap where Claude searches for a symbol by *filename pattern* instead of content. Without this hook, `Glob("*UserService*")` silently returns the file, Claude reads it, and LSP enforcement never fires.

The guard parses the glob pattern, extracts alphabetic tokens, and blocks if any token looks like a code symbol (PascalCase, camelCase, or snake_case with 3+ parts). Lowercase-only tokens and short generic words are always allowed.

| Pattern | Detected as | Action |
|---------|------------|--------|
| `*UserService*` | PascalCase symbol | BLOCK |
| `**/AuthProvider.tsx` | PascalCase in path | BLOCK |
| `*createOrder*` | camelCase symbol | BLOCK |
| `*handleSubmit*` | camelCase handler | BLOCK |
| `*get_user_sessions*` | snake_case function | BLOCK |
| `src/**/*.ts` | extension pattern | allow |
| `*.tsx`, `**/*.json` | extension pattern | allow |
| `*subdomain*`, `*auth*` | lowercase concept | allow |
| `**/middleware*` | file concept | allow |
| `tsconfig.json`, `next.config.ts` | framework config | allow |
| `README.md` | docs | allow |

**Allowed by design:** lowercase concept searches (`*auth*`, `*subdomain*`) are legitimate file discovery by topic. Only symbol-shaped tokens (casing patterns) are blocked, because those should use the `LSP` tool's `workspaceSymbol` operation instead.

### 3. `bash-grep-block.js` — Shell Grep & Symbol-Hunt Blocker

**Hook type:** PreToolUse | **Matcher:** `Bash`

Same detection logic as the Grep hook, but for `Bash(grep "UserService" src/)`, `Bash(rg handleSubmit)`, etc. — Claude sometimes tries to bypass the Grep hook by shelling out. Also catches `sed -n '/regex/,/regex/p'` and `awk '/regex/,/regex/'` used the same way (regex-*address* sed/awk, hunting a declaration or call-site) — a real bypass pattern seen in practice, since neither command contains `grep`/`rg`/`ag`/`ack`.

Allows: `git grep` (history search), non-code paths, non-code file type filters, and anything already satisfied by a prior `LSP` call this session.

### 4. `bash-code-view-block.js` — Bash Code-Viewing Blocker

**Hook type:** PreToolUse | **Matcher:** `Bash`

A different gap: a Bash command can view a code file's content — a line range or the whole thing — without ever containing a symbol pattern at all, so it's invisible to the hook above too. `sed -n '10,30p' file.go`, `awk '{print NR": "$0}' file.go`, bare `cat file.go`, and `git show <ref>:<path>` (colon form — fetches the full file at that ref) are functionally identical to a `Read` call, but bypass `lsp-first-read-guard.js`'s free-read/nav-count gate entirely since that hook only fires on `tool_name === 'Read'`.

This hook doesn't reimplement that gate — it blocks and redirects: use `Read` instead, which is already gated. `git diff` / `git log -p` / `git show <ref>` (no colon) stay exempt — those show a diff or commit history, not the file's current full content.

### 5. `lsp-first-read-guard.js` — Progressive Read Gate

**Hook type:** PreToolUse | **Matcher:** `Read`

The most sophisticated hook. Forces a "navigate first, read targeted" workflow through 5 gates:

```
Gate 1 — Warmup Required
  No LSP state file → BLOCK
  Must call LSP documentSymbol(<any project file>) first

Gate 2 — Free Orientation (reads 1-2)
  ALLOW — explore freely, no restrictions

Gate 3 — Warning (read 3)
  WARN if no LSP nav calls yet
  "Next Read will be BLOCKED"

Gate 4 — Navigation Required (reads 4-5)
  BLOCK if nav_count < 1
  Must use at least 1 LSP navigation call

Gate 5 — Surgical Mode (reads 6+)
  BLOCK if nav_count < 2
  After 2 nav calls → unlimited reads forever
```

**Session flow:**
```
Session starts
  │
  ├─ Read(page.tsx) → Gate 1 BLOCKS → "warmup required"
  │
  ├─ LSP documentSymbol(file.ts) → tracker writes warmup_done=true
  │
  ├─ Read(page.tsx) → Gate 2 allows (1 of 2 free)
  ├─ Read(actions.ts) → Gate 2 allows (2 of 2 free)
  ├─ Read(types.ts) → Gate 3 WARNS
  ├─ Read(helpers.ts) → Gate 4 BLOCKS
  │
  ├─ LSP workspaceSymbol("MyFunc") → tracker: nav_count=1
  │
  ├─ Read(helpers.ts) → unlocked (reads 4-5)
  ├─ Read(utils.ts) → unlocked
  ├─ Read(service.ts) → Gate 5 BLOCKS
  │
  ├─ LSP findReferences("MyFunc") → tracker: nav_count=2
  │
  └─ SURGICAL MODE — all Reads unlimited
```

**Always allowed (no gate):**
- Non-code files: `.md`, `.json`, `.yaml`, `.env`, `.sql`, `.css`, `.html`
- Config files: `tsconfig.json`, `next.config.ts`, `package.json`
- Test files: `*.test.ts`, `*.spec.tsx`
- Non-code paths: `.task/`, `.claude/`, `node_modules/`, `__tests__/`

**Dedup:** Reading the same file at different line ranges counts as 1 Read.

### 6. `lsp-pre-delegation.js` — Agent Pre-Resolution

**Hook type:** PreToolUse | **Matcher:** `Agent`

Without `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (see [Quick Start](#-quick-start), step 3), a delegated `Agent` call can run as a background task where the `LSP` tool isn't available at all — that subagent has no way to satisfy this kit's enforcement and falls straight back to exploratory Grep+Read. Even with it set, a subagent's own exploration doesn't share this session's LSP navigation history. Either way, this hook forces the orchestrator to resolve symbol locations via `LSP` first and hand them to the subagent directly, rather than trusting the subagent to redo that work.

```
// BLOCKED — no LSP context
Agent({
  prompt: "Fix handleSubmit in the form component",
  isolation: "worktree"
})

// ALLOWED — pre-resolved LSP context
Agent({
  prompt: `Fix handleSubmit error handling.

    ## LSP CONTEXT (pre-resolved by orchestrator)
    - handleSubmit: defined at form-actions.ts:42, called from page.tsx:15
    - FormComponent: defined at form.tsx:8, used in page.tsx:120`,
  isolation: "worktree"
})
```

**Three enforcement tiers:**

| Tier | Agents | Enforcement |
|------|--------|-------------|
| Force | `frontend-explorer`, `backend-explorer`, `db-explorer` | Always BLOCK without LSP context |
| Standard | Implementation agents, worktree-isolated agents | BLOCK during implement phase |
| Exempt | Reviewers, testers, planners, auditors | Never enforced (read-only) |

### 7. `lsp-session-reset.js` — Stale State Wiper

**Hook type:** SessionStart | **Matcher:** `true` (runs on every session start)

The Read guard's state file (`~/.claude/state/lsp-ready-<cwd-hash>`) has a 24-hour expiry. Without this hook, a new session inherits yesterday's `nav_count` — and if that count was ≥ 2, the guard is permanently in **surgical mode** for today's session: unlimited Reads with zero LSP calls required. A full bypass of the enforcement chain.

This hook runs once on session start and deletes the state file for the current cwd. The next Read triggers Gate 1 (warmup required), forcing at least one `LSP documentSymbol` call before any code file can be opened. After warmup, the standard progression kicks in (Gate 2 → 3 → 4 → 5) requiring real LSP navigation calls before surgical mode unlocks.

**Session lifecycle with reset:**
```
Session start
  │
  ├─ lsp-session-reset.js → unlinks lsp-ready-<hash>
  │
  ├─ Read(page.tsx) → Gate 1 BLOCKS → "warmup required"
  │
  ├─ LSP documentSymbol(file.ts) → tracker writes warmup_done=true
  │
  ├─ Read × 2 (free) → Gate 3 warn → Gate 4 block → LSP nav → …
  │
  └─ (2 nav calls later) SURGICAL MODE unlocked
```

**Safety:** the hook only deletes the flag for the current cwd — other projects' state files are left alone. Failure is silent (never blocks session start).

### 8. `lsp-usage-tracker.js` — State Tracker

**Hook type:** PostToolUse | **Matcher:** `LSP`

Tracks successful native `LSP` tool calls in a per-project state file. Other hooks read this state to make gate decisions. An errored `LSP` call (checked generically — error flags, error-shaped text, an empty result object) doesn't count.

**State file:** `~/.claude/state/lsp-ready-<md5-hash-of-cwd>`

```json
{
  "cwd": "/path/to/project",
  "warmup_done": true,
  "nav_count": 25,
  "read_count": 38,
  "read_files": ["src/page.tsx", "src/actions.ts"],
  "timestamp": 1775818285727,
  "last_tool": "LSP"
}
```

## 📦 Installation

### Option 1: Give the repo to Claude Code (recommended)

```bash
git clone https://github.com/nesaminua/claude-code-lsp-enforcement-kit.git
cd claude-code-lsp-enforcement-kit
```

Then tell Claude Code:

```
Run bash install.sh in this repo to set up LSP enforcement hooks.
```

The install script:
- Copies 8 hooks + shared `lib/lsp-suggestions.js` helper to `~/.claude/hooks/`
- Copies the LSP-first rule to `~/.claude/rules/`
- **Merges** hook registrations into your existing `~/.claude/settings.json` (won't overwrite your other hooks)
- Enables the built-in `typescript-lsp` plugin (wires up Claude Code's native LSP client for TS/JS — not an MCP server)
- Creates `~/.claude/state/` for tracking
- Verifies everything at the end
- Safe to re-run: entries are deduped by command path, and an older install's `PostToolUse` tracker matcher (if it still names `mcp__cclsp__*` tools) is migrated to `LSP` in place

### Option 2: Run the script yourself

**macOS / Linux:**
```bash
git clone https://github.com/nesaminua/claude-code-lsp-enforcement-kit.git
cd claude-code-lsp-enforcement-kit
bash install.sh
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/nesaminua/claude-code-lsp-enforcement-kit.git
cd claude-code-lsp-enforcement-kit
pwsh ./install.ps1
# or: powershell -ExecutionPolicy Bypass -File ./install.ps1
```

Output:
```
=== LSP Enforcement Kit — Install ===

[1/4] Directories ready
[2/4] Copied 8 hooks + lib + 1 rule
[3/4] settings.json updated (merged, not overwritten)
[4/4] Verifying...

  Hooks installed:  8/8
  Rule installed:   yes
  Plugin enabled:   yes
  State directory:  yes

Done. Restart Claude Code to activate.
```

### Option 3: Manual setup

<details>
<summary>Click to expand manual steps</summary>

#### Prerequisites

- Claude Code (CLI, Desktop, or IDE extension)
- Steps 1-3 from [Quick Start](#-quick-start) above already done: a language server available for your language, the plugin enabling it, and the two `env` vars (`ENABLE_LSP_TOOL`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`) set in `~/.claude/settings.json`

The steps below are the manual equivalent of Quick Start's step 4 (`install.sh`) — copying files and registering hooks by hand instead of running the script.

#### Step 1: Copy files

```bash
mkdir -p ~/.claude/hooks/lib ~/.claude/state ~/.claude/rules
cp hooks/*.js ~/.claude/hooks/
cp hooks/lib/*.js ~/.claude/hooks/lib/
cp rules/lsp-first.md ~/.claude/rules/
```

#### Step 2: Enable the plugin

In `~/.claude/settings.json`, add to `enabledPlugins`:

```json
{
  "enabledPlugins": {
    "typescript-lsp@claude-plugins-official": true
  }
}
```

#### Step 3: Register hooks in settings.json

**IMPORTANT:** If you already have hooks, **add** these entries to your existing arrays — don't replace them.

Add to `PreToolUse` array:

```json
{
  "matcher": "Grep",
  "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/lsp-first-guard.js" }]
},
{
  "matcher": "Glob",
  "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/lsp-first-glob-guard.js" }]
},
{
  "matcher": "Bash",
  "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/bash-grep-block.js" }]
},
{
  "matcher": "Bash",
  "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/bash-code-view-block.js" }]
},
{
  "matcher": "Read",
  "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/lsp-first-read-guard.js" }]
},
{
  "matcher": "Agent",
  "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/lsp-pre-delegation.js" }]
}
```

Add to `PostToolUse` array:

```json
{
  "matcher": "LSP",
  "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/lsp-usage-tracker.js" }]
}
```

Add to `SessionStart` array (create it if missing):

```json
{
  "matcher": "true",
  "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/lsp-session-reset.js" }]
}
```

</details>

### Verify

Run the health-check script:

```bash
bash scripts/lsp-status.sh
# or from anywhere after install:
bash ~/.claude/scripts/lsp-status.sh
```

Expected output:

```
LSP Enforcement Kit — Status
============================

  Hook files:          ✓ 8/8
  Shared lib/helper:   ✓ yes
  Settings registered: ✓ PreToolUse(6) PostToolUse(1) SessionStart(1)

State for current cwd (/path/to/project)
------------------------
  Warmup done:         yes
  nav_count:           5 (LSP navigation calls)
  read_count:          7 (unique code files read)
  Last tool:           LSP (2min ago)

  ✓ Surgical mode active — all Reads unlimited for this session.

Diagnostic summary
------------------
  All checks passed. Enforcement is active.
```

Or restart Claude Code and ask "Where is handleSubmit defined?" — Claude should use the `LSP` tool's `goToDefinition` operation, not Grep.

## 📚 LSP Tool Reference

All of these are `operation` values on Claude Code's single built-in `LSP` tool — not separate tools, and not MCP calls.

| Operation | Question It Answers | Output |
|-----------|-------------------|--------|
| `goToDefinition` | Where is X defined? | file:line of definition |
| `findReferences` | Where is X used? | All file:line usages |
| `workspaceSymbol` | Find anything named X | All matching symbols in project (requires a `query`) |
| `goToImplementation` | What implements this interface? | Concrete implementations |
| `prepareCallHierarchy` + `incomingCalls` | What calls X? | All callers with file:line |
| `prepareCallHierarchy` + `outgoingCalls` | What does X call? | All callees with file:line |
| `hover` | What type is X? | Type signature + docs |
| `documentSymbol` | What's in this file? | All symbols in the file (also used as the warmup call) |

## 🐍 Other Languages (Python, Go, Rust, …)

This kit doesn't bundle or require any language server itself — it only enforces *using* the `LSP` tool, whatever language server Claude Code has wired up behind it. `install.sh` enables the `typescript-lsp` plugin, which covers TypeScript/JavaScript out of the box.

For another language, you need Claude Code itself to have a language server configured for it (not an MCP server — this kit's hooks and suggestions won't route through one). Check Claude Code's own documentation/settings for wiring up additional language servers (e.g. `gopls` for Go, `pylsp`/`pyright` for Python, `rust-analyzer` for Rust). Once that's configured, the `LSP` tool's `operation`s work the same way for that language — this kit's hooks detect code symbols by naming convention (PascalCase, camelCase, snake_case), not by language, so nothing here needs to change.

## ❓ FAQ

**Q: Why no MCP server (cclsp, Serena, …) at all?**
Earlier versions suggested cclsp/Serena and detected which one you had installed. That's gone: Claude Code exposes LSP navigation as a native, built-in `LSP` tool — there's nothing to install, connect, or pick between. Real-session auditing found agents using this native tool successfully well before any MCP server was ever configured, and a stale "no LSP MCP server detected — install cclsp or Serena" suggestion is actively harmful — it tells the agent to go install something when a working tool is already sitting right there. If your Claude Code version predates the native `LSP` tool, this kit isn't the right fit; it won't fall back to suggesting an MCP server instead.

**Q: Does this work with Python/Go/Rust?**
Depends on whether Claude Code has a language server wired up for that language — see "Other Languages" above. This kit enables the `typescript-lsp` plugin (native, not MCP) for TS/JS; other languages need Claude Code's own equivalent configured. The hooks themselves detect symbols by naming convention, not language, so nothing here changes once that's set up.

**Q: What if LSP gives wrong results?**
The hooks don't eliminate Grep — they block Grep for *code symbols*. If LSP returns empty, Claude can still Grep with non-symbol patterns or search non-code files. The Read guard also gives 2 free reads before requiring navigation.

**Q: Won't the Read gate slow down simple tasks?**
After 2 LSP navigation calls, all gates open permanently (surgical mode). This happens within the first 30 seconds of a session. Non-code files (config, tests, docs) are never gated.

**Q: Why block Agent delegation without LSP context?**
A delegated subagent's tool access and context are its own — without pre-resolved symbol locations, it tends to fall back to exploratory Grep+Read, burning tokens and bypassing enforcement for its own turn. This hook forces the orchestrator to resolve locations via `LSP` first and hand them over directly.

**Q: What's the `bash-code-view-block.js` hook about — isn't `bash-grep-block.js` enough?**
No — they catch different things. `bash-grep-block.js` catches *searching* for a symbol via Bash (grep/rg/ag/ack, or regex-address sed/awk). `bash-code-view-block.js` catches *viewing* a code file's content via Bash with no symbol target at all — `sed -n 'N,Mp' file.go`, `awk '{print NR": "$0}' file.go`, bare `cat file.go`, `git show <ref>:<path>` — none of which contain a symbol pattern, so the search hook never sees them. Both were real bypass patterns found by auditing actual sessions: neither ever triggered any hook before these were added, so a `Read`'s free-read/nav-count gate could be routed around entirely just by using a different shell command to view the same content. `git diff`/`git log -p`/`git show <ref>` (no colon) stay exempt — reviewing a diff or commit history isn't the same as reading the file's current content cold.

**Q: I installed an older version and shared it with my team — should I upgrade?**
Yes. Besides earlier fixes (Glob symbol search, stale session state), this version removes MCP suggestions entirely and closes the two Bash bypass gaps above. Just re-run `bash install.sh` — it's idempotent, adds only the missing hook entries, and migrates an old `PostToolUse` tracker matcher (if it still names `mcp__cclsp__*` tools) to `LSP` in place. No other existing configuration is touched.

## 📄 License

MIT — see [LICENSE](LICENSE)

---

<p align="center">
  Made for Claude Code power users who care about token efficiency.
  <br>
  <a href="https://github.com/nesaminua/claude-code-lsp-enforcement-kit/issues">Report an issue</a> &bull;
  <a href="https://github.com/nesaminua/claude-code-lsp-enforcement-kit/releases">Releases</a> &bull;
  <a href="CHANGELOG.md">Changelog</a>
</p>
