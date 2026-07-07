#!/usr/bin/env node
/**
 * Direct Jira publisher — NO n8n, NO Docker. Uses curl + corporate proxy + UTF-8 temp-file bodies.
 * Actions: create-epic <md> | create-stories <epicKey> <md...> | update <key> <md> | set-parent <key> <epicKey> | get <key> | fetch <key> [outDir|outFile.md]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = process.env.ACP_ENV || path.join(HERE, '..', '.env');
const env = {};
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/\s+#.*$/, '').trim(); }
const BASE = env.JIRA_BASE_URL, AUTH = 'Basic ' + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
const PROJECT = env.JIRA_PROJECT_KEY, STORY = env.JIRA_STORY_ISSUE_TYPE || 'Story';
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || 'occyproxy.odysseycs.com:8080';
const OKLANG = new Set(['sql','json','javascript','typescript','java','csharp','c#','bash','shell','text','xml','yaml','python','html','css','plaintext']);

function mdToAdf(md) {
  const lines = md.replace(/\r/g, '').split('\n'); const nodes = []; let i = 0;
  function inlineToAdf(text) { const parts = []; const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g; let last = 0; let m; while ((m = regex.exec(text)) !== null) { if (m.index > last) parts.push({ type: 'text', text: text.slice(last, m.index) }); if (m[2]) parts.push({ type: 'text', text: m[2], marks: [{ type: 'strong' }] }); else if (m[3]) parts.push({ type: 'text', text: m[3], marks: [{ type: 'em' }] }); else if (m[4]) parts.push({ type: 'text', text: m[4], marks: [{ type: 'code' }] }); else if (m[5] && m[6]) parts.push({ type: 'text', text: m[5], marks: [{ type: 'link', attrs: { href: m[6] } }] }); last = m.index + m[0].length; } if (last < text.length) parts.push({ type: 'text', text: text.slice(last) }); if (parts.length === 0 && text) parts.push({ type: 'text', text }); return parts; }
  while (i < lines.length) { const line = lines[i];
    if (line.startsWith('```')) { let lang = line.slice(3).trim().toLowerCase() || null; const cl = []; i++; while (i < lines.length && !lines[i].startsWith('```')) { cl.push(lines[i]); i++; } i++; const cb = { type: 'codeBlock', content: cl.length ? [{ type: 'text', text: cl.join('\n') }] : [] }; if (lang && OKLANG.has(lang)) cb.attrs = { language: lang }; nodes.push(cb); continue; }
    const hm = line.match(/^(#{1,6}) (.+)$/); if (hm) { nodes.push({ type: 'heading', attrs: { level: hm[1].length }, content: inlineToAdf(hm[2]) }); i++; continue; }
    if (line.match(/^---+$/)) { nodes.push({ type: 'rule' }); i++; continue; }
    if (line.startsWith('> ')) { const ql = []; while (i < lines.length && lines[i].startsWith('> ')) { ql.push(lines[i].slice(2)); i++; } nodes.push({ type: 'blockquote', content: [{ type: 'paragraph', content: inlineToAdf(ql.join(' ')) }] }); continue; }
    if (line.match(/^- \[([ xX])\] /)) { let uid = 0; const items = []; while (i < lines.length && lines[i].match(/^- \[([ xX])\] /)) { const cm = lines[i].match(/^- \[([ xX])\] (.+)/); const state = (cm[1] === 'x' || cm[1] === 'X') ? 'DONE' : 'TODO'; items.push({ type: 'taskItem', attrs: { localId: 'task-' + (uid++), state }, content: inlineToAdf(cm[2]) }); i++; } nodes.push({ type: 'taskList', attrs: { localId: 'tl-' + uid }, content: items }); continue; }
    if (line.match(/^[-*] /)) { const items = []; while (i < lines.length && lines[i].match(/^[-*] /) && !lines[i].match(/^- \[([ xX])\] /)) { items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inlineToAdf(lines[i].replace(/^[-*] /, '')) }] }); i++; } nodes.push({ type: 'bulletList', content: items }); continue; }
    if (line.match(/^\d+[.)]/)) { const items = []; while (i < lines.length && lines[i].match(/^\d+[.)]/)) { items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inlineToAdf(lines[i].replace(/^\d+[.)] ?/, '')) }] }); i++; } nodes.push({ type: 'orderedList', content: items }); continue; }
    if (line.match(/^\|.+\|$/) && i + 1 < lines.length && lines[i+1].match(/^\|[-| :]+\|$/)) {
      const hc = line.split('|').filter(c => c.trim()).map(c => ({ type: 'tableHeader', attrs: {}, content: [{ type: 'paragraph', content: inlineToAdf(c.trim()) }] }));
      const rows = [{ type: 'tableRow', content: hc }]; i += 2;
      while (i < lines.length && lines[i].match(/^\|.+\|$/)) { rows.push({ type: 'tableRow', content: lines[i].split('|').filter(c => c.trim()).map(c => ({ type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: inlineToAdf(c.trim()) }] })) }); i++; }
      nodes.push({ type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' }, content: rows }); continue;
    }
    if (!line.trim()) { i++; continue; } nodes.push({ type: 'paragraph', content: inlineToAdf(line) }); i++; }
  return { type: 'doc', version: 1, content: nodes.length ? nodes : [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }] };
}
function parseMarkdown(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const titleLine = lines.find(l => l.startsWith('# '));
  let title = (titleLine ? titleLine.replace(/^# /, '') : 'Untitled').replace(/^[A-Z]+-[A-Z0-9]+\s*[—-]\s*/, '').trim();
  if (!/^\[[A-Za-z0-9]+\]/.test(title)) title = '[WS] ' + title;
  const titleIdx = lines.indexOf(titleLine);
  const known = ['Acceptance Criteria', 'Priority', 'Estimate', 'Component', 'Labels'];
  const bodyLines = [];
  for (let j = (titleIdx >= 0 ? titleIdx + 1 : 0); j < lines.length; j++) { if (lines[j].startsWith('## ') && known.some(s => lines[j] === '## ' + s)) break; bodyLines.push(lines[j]); }
  while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift(); while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();
  function getSection(h) { const s = lines.findIndex(l => l === '## ' + h); if (s === -1) return []; const o = []; for (let j = s + 1; j < lines.length; j++) { if (lines[j].startsWith('## ')) break; if (lines[j].trim()) o.push(lines[j]); } return o; }
  function getField(h) { const s = getSection(h); return s.length ? s[0].trim() : ''; }
  return { title, bodyMarkdown: bodyLines.join('\n'), criteria: getSection('Acceptance Criteria').filter(l => l.startsWith('- ')).map(l => l.replace(/^- /, '')), priority: getField('Priority'), component: getField('Component') };
}
function buildFields(parsed, parentKey, issueType, assigneeId) {
  let full = parsed.bodyMarkdown || '';
  if (parsed.criteria.length) { if (full) full += '\n\n'; full += '## Acceptance Criteria\n'; for (const c of parsed.criteria) full += '- ' + c + '\n'; }
  const fields = { project: { key: PROJECT }, issuetype: { name: issueType || STORY }, summary: parsed.title, description: mdToAdf(full), labels: ['ai-pipeline-generated'] };
  if (parsed.priority) fields.priority = { name: parsed.priority };
  if (parsed.component) fields.components = [{ name: parsed.component }];
  if (parentKey) fields.parent = { key: parentKey };
  if (assigneeId) { fields.assignee = { accountId: assigneeId }; fields.reporter = { accountId: assigneeId }; }
  return fields;
}
let _self;
async function selfId() { if (_self !== undefined) return _self; if (env.JIRA_DEFAULT_ASSIGNEE) { _self = env.JIRA_DEFAULT_ASSIGNEE; return _self; } const r = await jira('GET', '/rest/api/3/myself'); _self = r.json?.accountId || null; return _self; }
function extractKey(s) { const m = (s || '').match(/\/browse\/([A-Z]+-\d+)/); return m ? m[1] : (s || '').trim(); }

async function jira(method, p, body) {
  let tmpFile = null; const bodyArgs = [];
  if (body) { tmpFile = path.join(os.tmpdir(), `jira-body-${process.pid}-${Date.now()}.json`); fs.writeFileSync(tmpFile, JSON.stringify(body), 'utf8'); bodyArgs.push('--data-binary', `@${tmpFile}`); }
  try {
    const out = execFileSync('curl', ['-s', '-w', '\n%{http_code}', '--proxy', PROXY, '-X', method,
      '-H', `Authorization: ${AUTH}`, '-H', 'Content-Type: application/json', '-H', 'Accept: application/json',
      ...bodyArgs, BASE + p], { maxBuffer: 4 * 1024 * 1024 }).toString('utf8');
    const nl = out.lastIndexOf('\n'); const status = parseInt(out.slice(nl + 1), 10); const text = out.slice(0, nl);
    let j; try { j = JSON.parse(text); } catch { j = text; } return { status, json: j };
  } finally { if (tmpFile) try { fs.unlinkSync(tmpFile); } catch {} }
}

// ADF -> Markdown-ish text (for `fetch`)
function adfToMd(node, depth = 0) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(n => adfToMd(n, depth)).join('');
  const c = node.content;
  switch (node.type) {
    case 'doc': return adfToMd(c, depth);
    case 'paragraph': return adfToMd(c, depth) + '\n\n';
    case 'text': {
      let t = node.text || ''; const marks = (node.marks || []).map(m => m.type);
      if (marks.includes('code')) t = '`' + t + '`';
      if (marks.includes('strong')) t = '**' + t + '**';
      if (marks.includes('em')) t = '*' + t + '*';
      const link = (node.marks || []).find(m => m.type === 'link'); if (link) t = `[${t}](${link.attrs.href})`;
      return t;
    }
    case 'hardBreak': return '\n';
    case 'heading': return '#'.repeat(node.attrs?.level || 1) + ' ' + adfToMd(c, depth) + '\n\n';
    case 'bulletList': case 'orderedList': case 'taskList': return adfToMd(c, depth) + '\n';
    case 'listItem': return '  '.repeat(depth) + '- ' + adfToMd(c, depth + 1).replace(/\n\n$/, '\n').trim() + '\n';
    case 'taskItem': return '  '.repeat(depth) + '- [' + (node.attrs?.state === 'DONE' ? 'x' : ' ') + '] ' + adfToMd(c, depth).trim() + '\n';
    case 'codeBlock': return '```' + (node.attrs?.language || '') + '\n' + adfToMd(c, depth) + '\n```\n\n';
    case 'blockquote': return adfToMd(c, depth).split('\n').map(l => l ? '> ' + l : '').join('\n') + '\n';
    case 'rule': return '\n---\n\n';
    case 'mediaSingle': case 'mediaGroup': return '[media]\n\n';
    case 'media': return '[attachment: ' + (node.attrs?.id || '') + ']';
    case 'mention': return '@' + (node.attrs?.text || node.attrs?.id || '');
    case 'inlineCard': return node.attrs?.url || '[card]';
    case 'emoji': return node.attrs?.text || node.attrs?.shortName || '';
    case 'status': return '[' + (node.attrs?.text || '') + ']';
    case 'table': return adfToMd(c, depth) + '\n';
    case 'tableRow': return '| ' + (c || []).map(cell => adfToMd(cell.content, depth).replace(/\n+/g, ' ').trim()).join(' | ') + ' |\n';
    case 'tableHeader': case 'tableCell': return adfToMd(c, depth);
    default: return adfToMd(c, depth);
  }
}
const fmtDate = s => s ? s.slice(0, 16).replace('T', ' ') : '';

const [action, ...rest] = process.argv.slice(2);
const flags = rest.filter(a => a.startsWith('--'));
const args = rest.filter(a => !a.startsWith('--'));
const who = flags.includes('--unassigned') ? null : await selfId();
if (action === 'create-epic') {
  const parsed = parseMarkdown(fs.readFileSync(args[0], 'utf8'));
  const fields = buildFields(parsed, null, 'Epic', who); fields.summary = parsed.title.replace(/^\[WS\]\s*/, '');
  const r = await jira('POST', '/rest/api/3/issue', { fields });
  console.log(r.status >= 300 ? 'FAIL ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 700) : 'CREATED EPIC ' + r.json.key + ' | ' + fields.summary + '\n   ' + BASE + '/browse/' + r.json.key);
} else if (action === 'create-stories') {
  const epicKey = extractKey(args[0]);
  for (const f of args.slice(1)) {
    const parsed = parseMarkdown(fs.readFileSync(f, 'utf8'));
    const r = await jira('POST', '/rest/api/3/issue', { fields: buildFields(parsed, epicKey, null, who) });
    if (r.status >= 300) console.log('FAIL', f, r.status, JSON.stringify(r.json).slice(0, 700));
    else console.log('CREATED', r.json.key, '| assignee=self |', parsed.title, '\n  ', BASE + '/browse/' + r.json.key);
  }
} else if (action === 'update') {
  const key = extractKey(args[0]); const parsed = parseMarkdown(fs.readFileSync(args[1], 'utf8'));
  const fields = buildFields(parsed, null, null, who); delete fields.project; delete fields.issuetype;
  const r = await jira('PUT', '/rest/api/3/issue/' + key, { fields });
  console.log(r.status < 300 ? 'UPDATED ' + key + ' (assignee=self)' : 'FAIL ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 700));
} else if (action === 'set-parent') {
  const key = extractKey(args[0]), epicKey = extractKey(args[1]);
  const r = await jira('PUT', '/rest/api/3/issue/' + key, { fields: { parent: { key: epicKey } } });
  console.log(r.status < 300 ? 'REPARENTED ' + key + ' -> ' + epicKey : 'FAIL ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 700));
} else if (action === 'get') {
  const r = await jira('GET', '/rest/api/3/issue/' + extractKey(args[0]) + '?fields=summary,parent,issuetype,assignee,reporter,description');
  console.log(r.status, '|', r.json.fields?.issuetype?.name, '| parent', r.json.fields?.parent?.key, '| assignee', r.json.fields?.assignee?.displayName, '| reporter', r.json.fields?.reporter?.displayName, '| descNodes', r.json.fields?.description?.content?.length, '|', r.json.fields?.summary);
} else if (action === 'fetch') {
  // fetch <key> [outDir|outFile] — full ticket + linked issues + subtasks + all comments -> Markdown
  const key = extractKey(args[0]);
  const FIELDS = 'summary,status,issuetype,priority,assignee,reporter,created,updated,labels,components,fixVersions,parent,resolution,description,issuelinks,subtasks';
  const r = await jira('GET', '/rest/api/3/issue/' + key + '?fields=' + FIELDS);
  if (r.status >= 300) { console.log('FAIL ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 700)); process.exit(1); }
  const f = r.json.fields;
  let out = `# ${key} — ${f.summary}\n\n`;
  out += `| Field | Value |\n|---|---|\n`;
  out += `| Type | ${f.issuetype?.name} |\n| Status | ${f.status?.name} |\n| Resolution | ${f.resolution?.name || '—'} |\n`;
  out += `| Priority | ${f.priority?.name || '—'} |\n| Assignee | ${f.assignee?.displayName || '—'} |\n| Reporter | ${f.reporter?.displayName || '—'} |\n`;
  out += `| Created | ${fmtDate(f.created)} |\n| Updated | ${fmtDate(f.updated)} |\n`;
  out += `| Components | ${(f.components || []).map(x => x.name).join(', ') || '—'} |\n`;
  out += `| Fix Versions | ${(f.fixVersions || []).map(x => x.name).join(', ') || '—'} |\n`;
  out += `| Labels | ${(f.labels || []).join(', ') || '—'} |\n`;
  out += `| Parent | ${f.parent?.key || '—'} ${f.parent?.fields?.summary || ''} |\n`;
  out += `\n## Description\n\n` + (f.description ? adfToMd(f.description) : '_(empty)_') + '\n';
  if (f.issuelinks?.length) {
    out += `\n## Linked Issues\n\n`;
    for (const l of f.issuelinks) { const o = l.outwardIssue || l.inwardIssue; const rel = l.outwardIssue ? l.type.outward : l.type.inward; out += `- ${rel}: **${o.key}** — ${o.fields?.summary} _(${o.fields?.status?.name})_\n`; }
  }
  if (f.subtasks?.length) { out += `\n## Subtasks\n\n`; for (const s of f.subtasks) out += `- **${s.key}** — ${s.fields?.summary} _(${s.fields?.status?.name})_\n`; }
  const cr = await jira('GET', '/rest/api/3/issue/' + key + '/comment?maxResults=200&orderBy=created');
  out += `\n## Comments (${cr.json.total || 0})\n\n`;
  for (const cm of (cr.json.comments || [])) {
    out += `### ${cm.author?.displayName} — ${fmtDate(cm.created)}${cm.updated !== cm.created ? ' (edited ' + fmtDate(cm.updated) + ')' : ''}\n\n`;
    out += adfToMd(cm.body).trim() + '\n\n';
  }
  const dest = args[1];
  const fp = dest ? (/\.md$/i.test(dest) ? dest : path.join(dest, key + '.md')) : path.join(process.cwd(), key + '.md');
  fs.writeFileSync(fp, out, 'utf8');
  console.log('WROTE ' + fp + ' (' + out.length + ' chars, ' + (cr.json.total || 0) + ' comments)');
} else if (action) console.log('unknown action:', action);
