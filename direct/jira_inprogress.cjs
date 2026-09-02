#!/usr/bin/env node
// One-off: set ITP stories to In Progress, assignee+reporter=self, duedate.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { curlProxyArgs } = require('./proxy.cjs');

const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/\s+#.*$/, '').trim();
}
const BASE = env.JIRA_BASE_URL, AUTH = 'Basic ' + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
const PROXY_ARGS = curlProxyArgs(env);
const DUE = process.argv[2] || '2026-07-10';
const KEYS = ['CLS-13407', 'CLS-13410'];

function api(method, p, body) {
  const args = ['-s', '-w', '\n%{http_code}', ...PROXY_ARGS, '-X', method,
    '-H', `Authorization: ${AUTH}`, '-H', 'Content-Type: application/json', '-H', 'Accept: application/json'];
  let tmp = null;
  if (body) { tmp = path.join(require('node:os').tmpdir(), `jb-${Date.now()}-${Math.floor(performance.now())}.json`); fs.writeFileSync(tmp, JSON.stringify(body)); args.push('--data-binary', `@${tmp}`); }
  args.push(BASE + p);
  try { const out = execFileSync('curl', args, { maxBuffer: 8 * 1024 * 1024 }).toString('utf8'); const nl = out.lastIndexOf('\n'); const status = parseInt(out.slice(nl + 1), 10); let j = null; try { j = JSON.parse(out.slice(0, nl)); } catch {} return { status, j, raw: out.slice(0, nl) }; }
  finally { if (tmp) try { fs.unlinkSync(tmp); } catch {} }
}

const me = api('GET', '/rest/api/3/myself').j.accountId;
console.log('self accountId:', me, '| due:', DUE);

for (const k of KEYS) {
  // 1) fields: assignee + reporter + duedate (retry without reporter if rejected)
  let f = api('PUT', `/rest/api/3/issue/${k}`, { fields: { assignee: { accountId: me }, reporter: { accountId: me }, duedate: DUE } });
  let note = '';
  if (f.status >= 300) {
    note = ` (with-reporter ${f.status}: ${(f.raw || '').slice(0, 120)}; retried no-reporter)`;
    f = api('PUT', `/rest/api/3/issue/${k}`, { fields: { assignee: { accountId: me }, duedate: DUE } });
  }
  // 2) transition to In Progress
  const tr = api('GET', `/rest/api/3/issue/${k}/transitions`);
  const t = (tr.j?.transitions || []).find(x => /in\s*progress/i.test(x.name) || /in\s*progress/i.test(x.to?.name || ''));
  let tStatus = 'no-transition-found';
  if (t) { const r = api('POST', `/rest/api/3/issue/${k}/transitions`, { transition: { id: t.id } }); tStatus = `${t.name} -> ${r.status}`; }
  console.log(`${k}: fields=${f.status}${note} | transition=${tStatus}`);
}
