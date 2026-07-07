#!/usr/bin/env node
/**
 * Epic downloader — fetch an epic + all of its child stories (parent = <epic>) with FULL
 * descriptions, flatten ADF -> Markdown, and mirror into a docs folder.
 *
 *   node epic-download.mjs <EPIC-KEY> [<targetDir>]
 *
 * Default targetDir = ClearSkiesPlatform/Frontend/docs (relative to this repo's sibling layout).
 * Writes <targetDir>/<EPIC-KEY>-<slug>/EPIC-<EPIC-KEY>.md + one <STORY-KEY>.md per child.
 * Uses curl + the corporate proxy + .env creds (same as jira.mjs). NO n8n, NO Docker.
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
const BASE = env.JIRA_BASE_URL;
const AUTH = 'Basic ' + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || 'occyproxy.odysseycs.com:8080';

function jira(p) {
  const out = execFileSync('curl', ['-s', '-w', '\n%{http_code}', '--proxy', PROXY,
    '-H', `Authorization: ${AUTH}`, '-H', 'Accept: application/json', BASE + p],
    { maxBuffer: 16 * 1024 * 1024 }).toString('utf8');
  const nl = out.lastIndexOf('\n'); const status = parseInt(out.slice(nl + 1), 10); const text = out.slice(0, nl);
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status, json: j };
}

// ---- ADF -> Markdown ---------------------------------------------------------
function inline(nodes) {
  if (!Array.isArray(nodes)) return '';
  let s = '';
  for (const n of nodes) {
    if (n.type === 'text') {
      let t = n.text || '';
      const marks = n.marks || [];
      const has = (x) => marks.some(m => m.type === x);
      if (has('code')) t = '`' + t + '`';
      if (has('strong')) t = '**' + t + '**';
      if (has('em')) t = '*' + t + '*';
      if (has('strike')) t = '~~' + t + '~~';
      const link = marks.find(m => m.type === 'link');
      if (link && link.attrs && link.attrs.href) t = `[${t}](${link.attrs.href})`;
      s += t;
    } else if (n.type === 'hardBreak') {
      s += '  \n';
    } else if (n.type === 'inlineCard' && n.attrs && n.attrs.url) {
      s += n.attrs.url;
    } else if (n.type === 'mention' && n.attrs) {
      s += '@' + (n.attrs.text || n.attrs.id || '');
    } else if (n.type === 'emoji' && n.attrs) {
      s += n.attrs.text || n.attrs.shortName || '';
    } else if (n.type === 'status' && n.attrs) {
      s += '[' + (n.attrs.text || '') + ']';
    } else if (n.type === 'date' && n.attrs) {
      s += n.attrs.timestamp || '';
    } else if (n.content) {
      s += inline(n.content);
    }
  }
  return s;
}

function cellText(cell) {
  // a table cell's content is block nodes; join their inline text with spaces, escape pipes
  const parts = (cell.content || []).map(b => {
    if (b.type === 'paragraph' || b.type === 'heading') return inline(b.content);
    if (b.content) return inline(b.content);
    return '';
  });
  return parts.join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

function blocks(nodes, depth = 0) {
  if (!Array.isArray(nodes)) return '';
  const out = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'heading': {
        const lvl = (n.attrs && n.attrs.level) || 1;
        out.push('#'.repeat(Math.min(lvl, 6)) + ' ' + inline(n.content));
        break;
      }
      case 'paragraph': {
        out.push(inline(n.content));
        break;
      }
      case 'rule':
        out.push('---');
        break;
      case 'blockquote': {
        const inner = blocks(n.content, depth).split('\n').map(l => '> ' + l).join('\n');
        out.push(inner);
        break;
      }
      case 'panel': {
        const kind = (n.attrs && n.attrs.panelType) || 'info';
        const inner = blocks(n.content, depth).split('\n').map(l => '> ' + l).join('\n');
        out.push(`> [!${kind}]\n` + inner);
        break;
      }
      case 'codeBlock': {
        const lang = (n.attrs && n.attrs.language) || '';
        const code = (n.content || []).map(c => c.text || '').join('');
        out.push('```' + lang + '\n' + code + '\n```');
        break;
      }
      case 'bulletList': {
        out.push(listItems(n.content, depth, '- '));
        break;
      }
      case 'orderedList': {
        out.push(listItems(n.content, depth, null));
        break;
      }
      case 'taskList': {
        const items = (n.content || []).map(it => {
          const mark = (it.attrs && it.attrs.state === 'DONE') ? '[x]' : '[ ]';
          return '- ' + mark + ' ' + inline(flattenInline(it.content));
        });
        out.push(items.join('\n'));
        break;
      }
      case 'table': {
        out.push(table(n.content));
        break;
      }
      case 'decisionList': {
        const items = (n.content || []).map(it => '- ✔ ' + inline(flattenInline(it.content)));
        out.push(items.join('\n'));
        break;
      }
      case 'mediaSingle':
      case 'mediaGroup': {
        // images/attachments — note their presence, can't inline binary
        out.push('_[media attachment omitted]_');
        break;
      }
      default: {
        if (n.content) out.push(blocks(n.content, depth));
      }
    }
  }
  return out.filter(s => s !== undefined).join('\n\n');
}

// task items hold paragraphs whose content is inline; flatten to one inline array
function flattenInline(content) {
  const acc = [];
  for (const b of (content || [])) {
    if (b.type === 'text' || b.type === 'hardBreak' || b.type === 'inlineCard' || b.type === 'mention' || b.type === 'emoji') acc.push(b);
    else if (b.content) acc.push(...flattenInline(b.content));
  }
  return acc;
}

function listItems(items, depth, bullet) {
  const lines = [];
  let i = 1;
  for (const it of (items || [])) {
    const prefix = bullet || `${i}. `;
    const indent = '  '.repeat(depth);
    // an listItem's first paragraph is the item text; nested lists recurse with depth+1
    const inner = (it.content || []);
    let firstDone = false;
    for (const b of inner) {
      if ((b.type === 'paragraph' || b.type === 'heading') && !firstDone) {
        lines.push(indent + prefix + inline(b.content));
        firstDone = true;
      } else if (b.type === 'bulletList') {
        lines.push(listItems(b.content, depth + 1, '- '));
      } else if (b.type === 'orderedList') {
        lines.push(listItems(b.content, depth + 1, null));
      } else if (b.content) {
        lines.push(indent + '  ' + inline(b.content));
      }
    }
    if (!firstDone) lines.push(indent + prefix);
    i++;
  }
  return lines.join('\n');
}

function table(rows) {
  if (!rows || !rows.length) return '';
  const grid = rows.map(r => (r.content || []).map(cellText));
  const cols = Math.max(...grid.map(r => r.length));
  const norm = grid.map(r => { while (r.length < cols) r.push(''); return r; });
  const head = norm[0];
  const sep = head.map(() => '---');
  const body = norm.slice(1);
  const fmt = (r) => '| ' + r.join(' | ') + ' |';
  return [fmt(head), fmt(sep), ...body.map(fmt)].join('\n');
}

function adfToMd(adf) {
  if (!adf || !adf.content) return '';
  return blocks(adf.content).replace(/\n{3,}/g, '\n\n').trim();
}

function slugify(s) {
  return (s || '')
    .replace(/^\[[^\]]*\]\s*/, '')          // drop a leading [UI]/[WS] tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

// ---- main --------------------------------------------------------------------
const epicKey = (process.argv[2] || '').replace(/.*\/browse\//, '').trim();
const targetDir = process.argv[3] || path.join(HERE, '..', '..', 'ClearSkiesPlatform', 'Frontend', 'docs');
if (!epicKey) { console.error('usage: node epic-download.mjs <EPIC-KEY> [targetDir]'); process.exit(1); }

const FIELDS = 'summary,status,issuetype,description,parent';
const epicR = jira(`/rest/api/3/issue/${epicKey}?fields=${FIELDS}`);
if (epicR.status >= 300) { console.error('FAIL epic', epicKey, epicR.status, JSON.stringify(epicR.json).slice(0, 300)); process.exit(1); }
const ef = epicR.json.fields;
const epicSummary = ef.summary || epicKey;
const slug = slugify(epicSummary);
const folder = path.join(targetDir, `${epicKey}-${slug}`);
fs.mkdirSync(folder, { recursive: true });

// children — the enhanced /search/jql endpoint paginates by nextPageToken (it IGNORES startAt)
let token = null; const children = []; let pages = 0;
const jql = encodeURIComponent('parent=' + epicKey + ' ORDER BY key ASC');
while (true) {
  const tok = token ? `&nextPageToken=${encodeURIComponent(token)}` : '';
  const r = jira(`/rest/api/3/search/jql?jql=${jql}&fields=${FIELDS}&maxResults=100${tok}`);
  if (r.status >= 300) { console.error('FAIL children', r.status, JSON.stringify(r.json).slice(0, 300)); break; }
  const issues = r.json.issues || [];
  children.push(...issues);
  token = r.json.nextPageToken || null;
  if (r.json.isLast || !token || issues.length === 0) break;
  if (++pages > 50) { console.error('WARN children pagination guard tripped'); break; }
}

function statusName(f) { return f.status && f.status.name ? f.status.name : 'Unknown'; }

// EPIC file
let epicMd = `# ${epicKey} — ${epicSummary}\n\n`;
epicMd += `_status: ${statusName(ef)} · type: ${ef.issuetype?.name || 'Epic'}_\n\n`;
const epicDesc = adfToMd(ef.description);
if (epicDesc) epicMd += epicDesc + '\n\n';
epicMd += `## Child stories (${children.length})\n\n`;
if (children.length) {
  epicMd += `| Key | Status | Summary |\n| --- | --- | --- |\n`;
  for (const c of children) epicMd += `| ${c.key} | ${statusName(c.fields)} | ${(c.fields.summary || '').replace(/\|/g, '\\|')} |\n`;
} else {
  epicMd += `_No child stories found via \`parent = ${epicKey}\`._\n`;
}
fs.writeFileSync(path.join(folder, `EPIC-${epicKey}.md`), epicMd, 'utf8');

// child files
for (const c of children) {
  const f = c.fields;
  let md = `# ${c.key} — ${f.summary || ''}\n\n`;
  md += `_status: ${statusName(f)} · type: ${f.issuetype?.name || 'Story'}_\n\n`;
  const d = adfToMd(f.description);
  md += (d || '_No description._') + '\n';
  fs.writeFileSync(path.join(folder, `${c.key}.md`), md, 'utf8');
}

console.log(`OK ${epicKey} | "${epicSummary}" | ${children.length} children -> ${path.relative(process.cwd(), folder)}`);
