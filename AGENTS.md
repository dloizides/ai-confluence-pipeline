# AGENTS.md — start here

> This is the canonical onboarding file for **any** coding agent (Claude Code, Copilot, Cursor, …).
> `CLAUDE.md` and `.github/copilot-instructions.md` point back here. Read this first, then act.

## What this repo is

**Katastasi** (npm: `katastasi`; formerly `ai-confluence-pipeline`) is an open-source documentation,
task-tracking, and testing **framework** — local-first markdown source of truth, agent-native, syncing
to Jira/Confluence/issues/CI. It turns **markdown ⇄ Jira / Confluence** both ways and reports
**requirements traceability** (which requirements are actually covered by passing tests, at the commit).
The vision + roadmap is in **[VISION.md](VISION.md)**. Two ways to drive it, plus an optional
AI-authoring layer:

| Interface | Entry point | Use |
|-----------|-------------|-----|
| **`katastasi` CLI** (aliases `kat`, `acp`) | `src/cli/index.ts` → `dist/cli/index.js` | publish / pull / push-folder / trace / analyze / pipeline from a terminal |
| **`katastasi-mcp` MCP server** (alias `acp-mcp`) | `src/mcp/server.ts` → `dist/mcp/server.js` | let an agent call the same operations as tools |
| **n8n workflows** (optional) | `workflows/*.json` | AI-authoring + webhook publish (the "forward" flow) |

The core conversion + REST logic lives in `src/core/` and is plain TypeScript with **no n8n dependency**
— the CLI and MCP both call it directly.

## Capabilities (what you can already do)

- **Publish** markdown → Jira Epic+Stories or a Confluence page (`acp jira`, `acp confluence`).
- **Pull** (reverse) a Jira epic tree or Confluence page tree → a round-trippable markdown folder
  (`acp pull-jira`, `acp pull-confluence`) + an `acp-pull.json` manifest.
- **Push** an edited folder back recursively (`acp push-folder`).
- **Mermaid** diagrams round-trip both ways (Jira code block / Confluence macro).
- **Questions** — turn an open-questions markdown (mermaid flow + QA checklist) into a self-contained
  interactive decision HTML (`acp questions`); exported answers + diagram publish via `acp confluence`.
  See [docs/QUESTIONS.md](docs/QUESTIONS.md).
- **Trace** — link tests ↔ requirements ↔ status at the current git commit (`acp trace`), re-run
  suites on demand (`--run`), record history + flag **regressions**, and serve a web portal with a Run
  button (`acp trace serve`). Trigger from CLI/CI, the portal, an agent (MCP `requirements_trace`), or
  an n8n webhook (`POST /run`). Onboard with `acp trace init` (autodetect). See
  [docs/TRACEABILITY.md](docs/TRACEABILITY.md).
- **Acceptance tests** — a requirement-first runner (`katastasi test`): HTTP/REST + CLI cases authored as
  `.acp/tests/*.acp.{json,yml,md}` spec files or inline ` ```acp-test ` blocks (terse or JSON) under a
  requirement, with status/JSON-path/header/body assertions, capture-chaining, and env secrets. Emits
  JUnit keyed by requirement → `trace` verifies it. `analyze` generates the specs; agents call MCP
  `test_run`. See [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).
- **Tasks** — local markdown task tracking (`katastasi task …`) linked to requirements + tests, with a
  done-but-not-verified ⚠️ drift check. See [docs/PHASE-1-DESIGN.md](docs/PHASE-1-DESIGN.md).
- **Web wizard** — `katastasi web` (slice 1): a 100%-local browser onboarding wizard (loopback
  `node:http` + self-contained page). Connect step saves creds to local `.env`; later slices add
  paste-URL → discover → pull → design → sync. See [docs/WEB-WIZARD-DESIGN.md](docs/WEB-WIZARD-DESIGN.md).
- **Agent skills** — `katastasi init-skills` installs per-action skills into any repo
  (`.claude/skills/*` + `.github/copilot-instructions.md`) so Claude Code & Copilot run onboard / design /
  sync / trace / test / tasks as one-liners. Run once per service.
- **Bidirectional sync** — `katastasi sync`: reconcile `.acp/tasks ⇄ GitHub issues / Jira` 3-way
  (base/local/remote), revision-tracked, status round-trip (done⇄closed). Preview by default; `--apply`
  to write; conflicts flagged to `.acp/sync/conflicts/`, never clobbered. MCP `sync_preview`/`sync_apply`.
  See [docs/SYNC.md](docs/SYNC.md).
- **Feature wizard** — `katastasi wizard`: idea + requirements (Jira/Confluence/markdown) + code → a
  dev-ready **feature pack** (system + per-use-case mermaid, ordered context-rich tasks, unit/e2e/
  acceptance stubs, ready-made curls) as a self-contained HTML page (read → approve → run curls → verify)
  + markdown + optional Confluence. Generates only; the agent + dev execute. MCP `feature_wizard`.
  First-time auth: [docs/SOURCES_SETUP.md](docs/SOURCES_SETUP.md). Design: [docs/WIZARD-DESIGN.md](docs/WIZARD-DESIGN.md).

## Repo map

```
src/
  cli/index.ts            # the `acp` CLI (commander); all subcommands
  mcp/server.ts           # the `acp-mcp` stdio MCP server; one tool per operation
  core/
    config.ts             # .env loading + Atlassian Basic-auth creds
    atlassian.ts          # direct REST client (Jira + Confluence), read + write
    *toMarkdown.ts / markdownTo*.ts   # ADF / storage ⇄ markdown converters
    pull.ts / push.ts     # reverse pull + recursive re-publish
    questions/            # `acp questions` — open-questions md → interactive decision HTML
    trace/                # requirements traceability (see docs/TRACEABILITY.md)
      requirements/        #   providers: jira-epic / roadmap-html / confluence-page / markdown
      report/              #   markdown + self-contained HTML renderers
      index.ts             #   runTrace() orchestrator + renderAll()
test/*.test.js            # node:test, run against compiled dist/
docs/                     # setup, deploy, CLI/MCP, traceability, agent prompts
scripts/                  # docker build/deploy, getting-started, CLI wrappers (.sh + .ps1)
workflows/                # n8n pipelines (optional AI/forward flow)
```

## Setup

```bash
node --version          # need Node 20+
npm install
cp .env.example .env     # then fill in JIRA_* / CONFLUENCE_* (Atlassian API token, not a password)
npm run build            # tsc → dist/
```

`.env` keys that matter for direct REST: `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN`,
`CONFLUENCE_BASE_URL` / `CONFLUENCE_EMAIL` / `CONFLUENCE_API_TOKEN`, optional
`CONFLUENCE_MERMAID_MACRO`, plus optional `HTTPS_PROXY` — set that one only if your network
requires an egress proxy; unset means a direct connection. The forward n8n flow also uses `WEBHOOK_URL`. Full field-by-field in
[docs/SETUP.md](docs/SETUP.md).

## Build / test / verify commands

```bash
npm run build       # compile TS → dist/
npm run typecheck   # tsc --noEmit (keep at 0 errors)
npm test            # builds first, then runs node --test on test/**/*.test.js
```

There is **no Tilt / Jest / vitest here** — tests are plain `node --test` files that import from
`dist/`, so you must build before running them (`npm test` does both). Network calls (Jira/Confluence)
are exercised against **mock HTTP servers / injected clients** in tests — never a live instance.

## Deploy

It ships as one Docker image exposing `acp` + `acp-mcp`. Simple guide:
**[docs/DEPLOY.md](docs/DEPLOY.md)**. Fastest path:

```bash
./scripts/getting-started.sh            # local Docker Desktop, or remote host over SSH
```

For an agent to deploy autonomously, use the paste-ready prompts in
[docs/DEPLOY_PROMPT.md](docs/DEPLOY_PROMPT.md). Deep reference: [docs/DOCKER.md](docs/DOCKER.md).

## Conventions (follow these)

- **TypeScript ESM, NodeNext.** Relative imports use a **`.js`** extension even though the source is
  `.ts` (e.g. `import { foo } from './bar.js'`). Match this or the build breaks.
- **Keep `src/core/` n8n-free.** New conversion / REST logic goes in `core/`, surfaced by both the CLI
  and the MCP server. Don't duplicate logic into a script — wrap the CLI instead.
- **Small, focused files.** Tolerant parsers (the XHTML/JUnit/markdown readers are regex-based and
  degrade gracefully rather than throw). Prefer pure functions + a thin network wrapper so the pure
  part is unit-testable offline.
- **No casual dependencies.** Current deps: `commander`, `@modelcontextprotocol/sdk`, `zod`, `dotenv`.
  The glob, mini-YAML, and XML readers are hand-rolled on purpose — don't add libraries without reason.
- **Add a test for new behaviour** in `test/*.test.js` (fixtures, not live network).
- **Round-trip safety matters** — pull → edit → push must be lossless (that's why mermaid source is
  preserved, not flattened). Don't break it.

## Definition of done for a change

1. `npm run typecheck` clean, `npm test` green (add/adjust tests for what you changed).
2. If you touched the CLI or MCP surface, update **[docs/CLI_AND_MCP.md](docs/CLI_AND_MCP.md)** and the
   relevant feature doc.
3. If you added a capability, add a line to the README and to the capability table above.
4. Commit only when the user asks; never push without being asked.

## Where to look first

| I want to… | Read |
|------------|------|
| Set up locally | [docs/INSTALL.md](docs/INSTALL.md) + [docs/SETUP.md](docs/SETUP.md) |
| Use the CLI / MCP | [docs/CLI_AND_MCP.md](docs/CLI_AND_MCP.md) |
| Deploy on Docker | [docs/DEPLOY.md](docs/DEPLOY.md) |
| Understand traceability | [docs/TRACEABILITY.md](docs/TRACEABILITY.md) |
| Onboard a team to traceability | [docs/ONBOARDING.md](docs/ONBOARDING.md) (`acp trace init --all`) |
| Requirements → tech analysis → tasks + tests | [docs/TECH_ANALYSIS_FLOW.md](docs/TECH_ANALYSIS_FLOW.md) (`acp trace pull-requirements` → `acp analyze`) |
| Have an agent deploy it | [docs/DEPLOY_PROMPT.md](docs/DEPLOY_PROMPT.md) |
