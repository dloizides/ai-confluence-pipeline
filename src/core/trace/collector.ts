/**
 * `acp trace collector` — a self-hosted server of record. It RECEIVES reports posted by `output.post`
 * (from every dev / CI run), stores them per project, and serves an aggregated read-only dashboard.
 * This is the "store results on a server" path for teams that don't use Jira/Confluence: central
 * storage + a team overview, fed by HTTP POSTs instead of git.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listRuns, loadPreviousRun, loadRun, saveRun } from './history.js';
import { renderHtml } from './report/html.js';
import type { TraceReport } from './types.js';

export interface CollectorOptions {
  port?: number;
  host?: string;
  /** Directory where posted reports are stored (per project). */
  dir?: string;
  /** Shared secret required to POST /ingest (and to view, unless --public). */
  token?: string;
  /** Allow viewing without the token (ingest still requires it). */
  public?: boolean;
  /** Cap stored runs per project. */
  keep?: number;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
}

function projects(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, no) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 64 * 1024 * 1024) no(new Error('payload too large'));
    });
    req.on('end', () => ok(b));
    req.on('error', no);
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Hub navigation bar -----------------------------------------------------
// Env-configurable so the shared collector stays company-agnostic: a deployment
// sets its own brand + links via the container env, nothing is hardcoded here.
//   RTM_BRAND      brand text        (default "Status Hub")
//   RTM_BRAND_ICON leading emoji     (default "📊")
//   RTM_NAV        JSON array of {label,href} — http(s) hrefs open in a new tab
//   RTM_SIGNOUT_URL if set, renders a "Sign out" link (e.g. /oauth2/sign_out)
const BRAND = process.env.RTM_BRAND ?? 'Status Hub';
const BRAND_ICON = process.env.RTM_BRAND_ICON ?? '📊';
const SIGNOUT_URL = process.env.RTM_SIGNOUT_URL ?? '';

function navLinks(): { label: string; href: string }[] {
  try {
    const raw = JSON.parse(process.env.RTM_NAV ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return (raw as { label: string; href: string }[]).filter((l) => l && l.label && l.href);
  } catch {
    return [];
  }
}

const NAV_CSS =
  '.hubnav{position:sticky;top:12px;z-index:20;display:flex;align-items:center;gap:16px;padding:11px 16px;margin:0 0 22px;' +
  'background:#0d1117;border:1px solid #30363d;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.16)}' +
  '.hubnav .brand{font-weight:700;font-size:15px;color:#fff;text-decoration:none;white-space:nowrap}' +
  '.hubnav .links{display:flex;gap:18px;flex:1;flex-wrap:wrap}' +
  '.hubnav .links a{color:#adbac7;text-decoration:none;font-size:13px;font-weight:500}' +
  '.hubnav .links a:hover{color:#fff}' +
  '.hubnav .signout{color:#adbac7;text-decoration:none;font-size:12px;font-weight:600;border:1px solid #30363d;' +
  'border-radius:6px;padding:6px 12px;white-space:nowrap}.hubnav .signout:hover{border-color:#8b949e;color:#fff}';

function navBar(): string {
  const links = navLinks()
    .map((l) => {
      const ext = /^https?:/i.test(l.href) ? ' target="_blank" rel="noopener"' : '';
      return `<a href="${esc(l.href)}"${ext}>${esc(l.label)}</a>`;
    })
    .join('');
  const signout = SIGNOUT_URL ? `<a class="signout" href="${esc(SIGNOUT_URL)}">Sign out</a>` : '';
  return `<nav class="hubnav"><a class="brand" href="/">${esc(BRAND_ICON)} ${esc(BRAND)}</a><div class="links">${links}</div>${signout}</nav>`;
}

/** Aggregate index: one row per project with its latest status. */
function indexPage(dir: string): string {
  const rows = projects(dir).map((slug) => {
    const r = loadPreviousRun(join(dir, slug));
    if (!r) return `<tr><td>${esc(slug)}</td><td colspan="5">(no runs)</td></tr>`;
    const s = r.stats;
    const reg = s.regressions ? ` ⛔${s.regressions}` : '';
    return (
      `<tr><td><a href="/p/${encodeURIComponent(slug)}">${esc(r.project ?? slug)}</a></td>` +
      `<td>${s.coveragePct}%</td><td>${s.verified}/${s.total}</td><td>${s.failing}</td>` +
      `<td>${esc(r.git.shortSha ?? '—')}${reg}</td><td>${esc(r.generatedAt.slice(0, 16).replace('T', ' '))}</td></tr>`
    );
  });
  const body = rows.length ? rows.join('') : '<tr><td colspan="6">No reports yet — point a project\'s <code>output.post</code> at <code>/ingest</code>.</td></tr>';
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(BRAND)}</title>` +
    '<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:32px;color:#24292f}' +
    'h1{font-size:20px}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #eaeef2}' +
    'th{background:#f6f8fa;font-size:12px;text-transform:uppercase;color:#57606a}a{color:#0969da}' +
    NAV_CSS +
    '</style></head><body>' +
    navBar() +
    '<h1>Requirements Traceability — all projects</h1>' +
    '<table><thead><tr><th>Project</th><th>Coverage</th><th>Verified</th><th>Failing</th><th>Commit</th><th>Updated</th></tr></thead>' +
    `<tbody>${body}</tbody></table></body></html>`
  );
}

function isReport(x: unknown): x is TraceReport {
  return Boolean(x) && typeof x === 'object' && Array.isArray((x as TraceReport).requirements) && Boolean((x as TraceReport).stats);
}

/** Start the collector. Resolves with the listening server. */
export async function serveCollector(opts: CollectorOptions = {}): Promise<Server> {
  const port = opts.port ?? 9000;
  const host = opts.host ?? '0.0.0.0';
  const dir = opts.dir ?? 'collector-data';
  const token = opts.token && opts.token.length ? opts.token : undefined;
  const isPublic = Boolean(opts.public);

  function authed(req: IncomingMessage, url: URL): boolean {
    if (!token) return true;
    if (req.headers.authorization === `Bearer ${token}`) return true;
    if (url.searchParams.get('token') === token) return true;
    return (req.headers.cookie ?? '').split(';').some((p) => p.trim() === `rtm_token=${token}`);
  }

  /** True when the token arrived via ?token= or Bearer (not the cookie) — so we should (re)issue the cookie. */
  function suppliedTokenExplicitly(req: IncomingMessage, url: URL): boolean {
    if (!token) return false;
    return req.headers.authorization === `Bearer ${token}` || url.searchParams.get('token') === token;
  }

  /** Persist the auth across same-origin navigations: one tokened visit sets an http-only cookie. */
  function setAuthCookie(req: IncomingMessage, url: URL, res: ServerResponse): void {
    if (suppliedTokenExplicitly(req, url) && token) {
      res.setHeader('Set-Cookie', `rtm_token=${token}; Path=/; HttpOnly; SameSite=Lax`);
    }
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => json(res, 500, { error: err instanceof Error ? err.message : String(err) }));
  });
  await new Promise<void>((ok) => server.listen(port, host, ok));
  process.stdout.write(`\n  RTM collector: http://${host}:${port}  (store: ${dir})\n  POST /ingest a report (Authorization: Bearer <token>)  ·  GET / for the overview\n`);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const key = `${req.method} ${url.pathname}`;

    // If this request carried the token via ?token= / Bearer, issue the cookie so subsequent
    // same-origin navigations (detail pages, /api/*) stay authed without re-supplying ?token=.
    setAuthCookie(req, url, res);

    if (key === 'POST /ingest') {
      if (token && !authed(req, url)) return json(res, 401, { error: 'unauthorized' });
      const report = JSON.parse(await readBody(req)) as unknown;
      if (!isReport(report)) return json(res, 400, { error: 'not a trace report (need requirements[] + stats)' });
      const slug = slugify(report.project ?? 'default');
      const path = saveRun(report, join(dir, slug));
      return json(res, 200, { ok: true, project: slug, stored: path.split(/[\\/]/).pop() });
    }
    // Views (optionally token-gated)
    if (token && !authed(req, url) && !isPublic) return json(res, 401, { error: 'unauthorized — append ?token=' });
    if (key === 'GET /' || key === 'GET /index.html') return html(res, indexPage(dir));
    if (key === 'GET /api/projects') return json(res, 200, { projects: projects(dir) });

    const view = url.pathname.match(/^\/p\/([^/]+)(?:\/runs\/([^/]+))?$/);
    if (req.method === 'GET' && view) {
      const slug = decodeURIComponent(view[1]);
      const file = view[2];
      if (file && (file.includes('..') || !file.endsWith('.json'))) return json(res, 404, { error: 'not found' });
      const report = file ? loadRun(join(dir, slug, file)) : loadPreviousRun(join(dir, slug));
      if (!report) return json(res, 404, { error: 'no report' });
      const runs = listRuns(join(dir, slug)).map((p) => p.split(/[\\/]/).pop() as string).reverse().slice(0, 20);
      const histLinks = runs.map((r) => `<a href="/p/${encodeURIComponent(slug)}/runs/${encodeURIComponent(r)}">${esc(r.slice(0, 19))}</a>`).join(' · ');
      const back = `<div style="margin:14px 0 4px"><a href="/">← all projects</a> · history: ${histLinks}</div>`;
      const inject = `<style>${NAV_CSS}</style>${navBar()}${back}`;
      return html(res, renderHtml(report).replace('<div class="wrap">', `${inject}<div class="wrap">`));
    }
    json(res, 404, { error: `no route: ${key}` });
  }

  return server;
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
