# `direct/` — Confluence & Jira via the Atlassian REST API (no n8n)

Small Node scripts that publish Markdown to **Confluence** and **Jira** by calling the Atlassian
REST API directly — no n8n webhook, no Docker. They reuse the pipeline's **own** Markdown converters
(`mdToConfluenceHtml`, `mdToAdf`) so output matches the n8n path, but run standalone from the CLI.

Use this when the n8n stack is down or you just want a dependency-light way to push a `.md` file to a
page or an epic.

## Setup

Credentials are read from `../.env` (the repo root `.env`, which is gitignored). Required keys:

```
CONFLUENCE_BASE_URL=https://your-domain.atlassian.net
CONFLUENCE_EMAIL=you@example.com
CONFLUENCE_API_TOKEN=...
CONFLUENCE_SPACE_KEY=YOURSPACE

JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=...
JIRA_PROJECT_KEY=ABC
JIRA_STORY_ISSUE_TYPE=Story
# optional: JIRA_DEFAULT_ASSIGNEE=<accountId>   (defaults to the token owner)
```

- Point at a different env file with `ACP_ENV=/path/to/.env`.
- Set `HTTPS_PROXY` **only if your network requires an egress proxy** (e.g. `export HTTPS_PROXY=host:8080`,
  or `HTTPS_PROXY=host:8080` in `.env`); leave it unset otherwise and the scripts connect directly.
  A shell `HTTPS_PROXY`/`https_proxy` wins over the `.env` value — there is no built-in default proxy.
- Requires `curl` on `PATH` and Node 18+. The mermaid renderer needs a local **Chrome/Edge**.

## Confluence — `confluence.mjs`

```bash
node confluence.mjs tiny <code>                       # /wiki/x/<code> short link → numeric pageId
node confluence.mjs get  <pageId>                     # confirm title / space / current version
node confluence.mjs create  <parentId> <file.md> [--mermaid]   # create a NEW child page
node confluence.mjs publish <pageId>   <file.md> [--mermaid] [--newtitle]
```

- **`publish`** updates in place: keeps the existing page title (pass `--newtitle` to adopt the
  Markdown `# H1`) and bumps the version by 1.
- **`--mermaid`**: Confluence can't render ```` ```mermaid ```` fences. With this flag each block is
  rendered to a PNG via headless system Chrome (`render_mermaid.cjs`), attached to the page, and the
  code macro is swapped for `<ac:image>`. Keep the mermaid source in the `.md` (source of truth).
- Confluence validates storage XML on write, so a malformed body returns 400 and leaves the page
  untouched — a bad render can never publish garbage.

## Jira — `jira.mjs`

```bash
node jira.mjs create-epic   <file.md>                 # create an Epic
node jira.mjs create-stories <epicKey> <md1> [md2 …]  # Stories under an existing epic
node jira.mjs update        <issueKey> <file.md>
node jira.mjs set-parent    <issueKey> <epicKey>
node jira.mjs get           <issueKey>                # type / parent / assignee / desc length
node jira.mjs fetch         <issueKey> [outDir|out.md] # full ticket + links + subtasks + all comments -> Markdown
```

- Team-managed projects link a Story to its Epic via `fields.parent = { key: <epicKey> }` (there is
  no Epic-Link custom field).
- Created/updated issues default to **assignee = reporter = the API-token owner** (resolved via
  `/rest/api/3/myself`); override with `JIRA_DEFAULT_ASSIGNEE`.
- Markdown: `# KEY — [TAG] Title` (the `KEY — ` prefix is stripped for the summary), `## Acceptance
  Criteria` becomes an ADF task list. A `[WS]` work-type tag is prepended unless the H1 already has one.

## Markdown the converters understand

`# Title`, `## Section`, paragraphs, **bold**/*italic*/`code`, `[links](url)`, tables, fenced code,
`- `/`* ` bullets, `1.` ordered lists, `> ` quotes, `- [ ]` task lists, `---` rules, ```` ```mermaid ````.
Jira also recognises `## Acceptance Criteria` / `## Priority` / `## Component` / `## Labels`.

## Always verify (never trust a success-shaped response)

- Confluence: `node confluence.mjs get <id>` → version bumped; with `--mermaid`, expect `<ac:image>`
  and zero leftover mermaid code macros in `body.storage`.
- Jira: `node jira.mjs get <key>` → `parent` set to the epic, `descNodes > 0`.

> The converters (`mdToConfluenceHtml`, `mdToAdf`/`parseMarkdown`/`buildJiraFields`) are copied
> **verbatim** from the n8n workflow JSON. If a workflow converter node changes, re-copy it — don't
> hand-rewrite it here.
