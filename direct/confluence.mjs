#!/usr/bin/env node
/**
 * Direct Confluence publisher — NO n8n, NO Docker. curl + optional egress proxy + UTF-8 temp bodies.
 * Converter (mdToConfluenceHtml) is the verbatim copy from workflows/markdown-to-confluence-pipeline.json,
 * EXCEPT the ```mermaid``` branch: blocks are rendered to PNG (system Chrome, see render_mermaid.cjs),
 * attached to the page, and emitted as <ac:image><ri:attachment/></ac:image> (matches the team convention).
 *
 * Actions:
 *   tiny <code>                         /wiki/x/<code> → numeric pageId
 *   get <pageId>                        title / space / version
 *   create <parentId> <md> [--no-mermaid]   create a NEW child page (under a page or folder)
 *   publish <pageId> <md> [--no-mermaid]    update-in-place (version+1)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { curlProxyArgs } from './proxy.cjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = process.env.ACP_ENV || path.join(HERE, '..', '.env');
const env = {};
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/\s+#.*$/, '').trim(); }
const BASE = env.CONFLUENCE_BASE_URL;
const AUTH = 'Basic ' + Buffer.from(`${env.CONFLUENCE_EMAIL}:${env.CONFLUENCE_API_TOKEN}`).toString('base64');
const SPACE_KEY = env.CONFLUENCE_SPACE_KEY;
const PROXY_ARGS = curlProxyArgs(env);

// ---- verbatim converter (mermaid branch swapped for ac:image) ----
function mdToConfluenceHtml(md, mermaidNames /* array of filenames, consumed in order */) {
  const lines = md.replace(/\r/g, '').split('\n');
  let html = '', inCodeBlock = false, codeContent = '', codeLang = 'text', inList = false, mIdx = 0;
  function fmt(t) { t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); return t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>'); }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```') && !inCodeBlock) { if (inList) { html += '</ul>'; inList = false; } inCodeBlock = true; codeLang = line.slice(3).trim() || 'text'; codeContent = ''; continue; }
    if (line.startsWith('```') && inCodeBlock) { inCodeBlock = false;
      if (codeLang.toLowerCase() === 'mermaid') {
        const fn = mermaidNames[mIdx++];
        html += fn ? '<ac:image ac:align="center"><ri:attachment ri:filename="' + fn + '" /></ac:image>'
                   : '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[' + codeContent.trim() + ']]></ac:plain-text-body></ac:structured-macro>';
      } else { html += '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">' + codeLang + '</ac:parameter><ac:plain-text-body><![CDATA[' + codeContent.trim() + ']]></ac:plain-text-body></ac:structured-macro>'; }
      continue; }
    if (inCodeBlock) { codeContent += line + '\n'; continue; }
    if (line.match(/^\|.+\|$/) && i + 1 < lines.length && lines[i+1].match(/^\|[-| :]+\|$/)) {
      if (inList) { html += '</ul>'; inList = false; }
      const headers = line.split('|').filter(c => c.trim()).map(c => '<th>' + fmt(c.trim()) + '</th>').join('');
      html += '<table><thead><tr>' + headers + '</tr></thead><tbody>'; i++;
      while (i + 1 < lines.length && lines[i+1].match(/^\|.+\|$/)) { i++; html += '<tr>' + lines[i].split('|').filter(c => c.trim()).map(c => '<td>' + fmt(c.trim()) + '</td>').join('') + '</tr>'; }
      html += '</tbody></table>'; continue;
    }
    const hm = line.match(/^(#{1,6}) (.+)$/);
    if (hm) { if (inList) { html += '</ul>'; inList = false; } html += '<h' + hm[1].length + '>' + fmt(hm[2]) + '</h' + hm[1].length + '>'; continue; }
    if (line.match(/^---+$/)) { if (inList) { html += '</ul>'; inList = false; } html += '<hr/>'; continue; }
    if (line.startsWith('> ')) { if (inList) { html += '</ul>'; inList = false; } html += '<blockquote><p>' + fmt(line.slice(2)) + '</p></blockquote>'; continue; }
    if (line.match(/^- \[([ xX])\] /)) { if (inList) { html += '</ul>'; inList = false; } html += '<ac:task-list>'; while (i < lines.length && lines[i].match(/^- \[([ xX])\] /)) { const cm = lines[i].match(/^- \[([ xX])\] (.+)/); html += '<ac:task><ac:task-status>' + ((cm[1]==='x'||cm[1]==='X') ? 'complete' : 'incomplete') + '</ac:task-status><ac:task-body>' + fmt(cm[2]) + '</ac:task-body></ac:task>'; i++; } html += '</ac:task-list>'; continue; }
    if (line.match(/^[-*] /)) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + fmt(line.replace(/^[-*] /, '')) + '</li>'; continue; }
    if (line.trim() === '') { if (inList) { html += '</ul>'; inList = false; } continue; }
    if (inList) { html += '</ul>'; inList = false; }
    html += '<p>' + fmt(line) + '</p>';
  }
  if (inList) html += '</ul>';
  // [[TOC]] on its own line → Confluence Table of Contents macro
  html = html.replace(/<p>\[\[TOC\]\]<\/p>/g, '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro>');
  return html;
}

function extractMermaid(md) { return [...md.replace(/\r/g, '').matchAll(/```mermaid\n([\s\S]*?)```/g)].map(m => m[1]); }
function titleOf(md) { const m = md.replace(/\r/g, '').match(/^# (.+)$/m); return m ? m[1].trim() : 'Untitled'; }

async function conf(method, p, body) {
  let tmp = null; const extra = [];
  if (body) { tmp = path.join(os.tmpdir(), `conf-${process.pid}-${Date.now()}.json`); fs.writeFileSync(tmp, JSON.stringify(body), 'utf8'); extra.push('--data-binary', `@${tmp}`); }
  try {
    const out = execFileSync('curl', ['-s', '-w', '\n%{http_code}', ...PROXY_ARGS, '-X', method,
      '-H', `Authorization: ${AUTH}`, '-H', 'Content-Type: application/json', '-H', 'Accept: application/json',
      ...extra, BASE + p], { maxBuffer: 16 * 1024 * 1024 }).toString('utf8');
    const nl = out.lastIndexOf('\n'); const status = parseInt(out.slice(nl + 1), 10); const text = out.slice(0, nl);
    let j; try { j = JSON.parse(text); } catch { j = text; } return { status, json: j };
  } finally { if (tmp) try { fs.unlinkSync(tmp); } catch {} }
}

function uploadAttachment(pageId, file) {
  const out = execFileSync('curl', ['-s', '-w', '\n%{http_code}', ...PROXY_ARGS, '-X', 'POST',
    '-H', `Authorization: ${AUTH}`, '-H', 'X-Atlassian-Token: nocheck',
    '-F', 'minorEdit=true', '-F', `file=@${file}`,
    `${BASE}/wiki/rest/api/content/${pageId}/child/attachment`], { maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
  const nl = out.lastIndexOf('\n'); return parseInt(out.slice(nl + 1), 10);
}

async function spaceId() {
  const r = await conf('GET', `/wiki/api/v2/spaces?keys=${SPACE_KEY}`);
  return r.json?.results?.[0]?.id || null;
}

function renderAll(md, baseName) {
  const { render } = require('./render_mermaid.cjs');
  const blocks = extractMermaid(md);
  const names = [];
  for (let k = 0; k < blocks.length; k++) {
    const fn = `${baseName}-${k + 1}.png`;
    const outPath = path.join(os.tmpdir(), fn);
    const r = render(blocks[k], outPath);
    if (!r.ok) throw new Error('render failed for block ' + (k + 1));
    names.push({ fn, outPath });
    console.error(`  rendered ${fn} (${r.vb})`);
  }
  return names;
}

const [action, ...rest] = process.argv.slice(2);
const flags = rest.filter(a => a.startsWith('--'));
const args = rest.filter(a => !a.startsWith('--'));
const useMermaid = !flags.includes('--no-mermaid');

if (action === 'tiny') {
  const r = await conf('GET', `/wiki/x/${args[0]}`); console.log(r.status, typeof r.json === 'string' ? r.json.slice(0, 200) : JSON.stringify(r.json).slice(0, 200));
} else if (action === 'get') {
  const r = await conf('GET', `/wiki/api/v2/pages/${args[0]}?body-format=storage`);
  const b = r.json?.body?.storage?.value || '';
  console.log('status', r.status, '| title:', r.json?.title, '| version:', r.json?.version?.number,
    '| ac:image:', (b.match(/<ac:image/g) || []).length, '| leftover mermaid fences:', (b.match(/```mermaid/g) || []).length,
    '| webui:', BASE + '/wiki' + (r.json?._links?.webui || ''));
} else if (action === 'create') {
  const parentId = args[0]; const md = fs.readFileSync(args[1], 'utf8'); const title = titleOf(md);
  const baseName = 'mermaid-' + Date.now().toString(36);
  let names = [];
  if (useMermaid) { console.error('rendering mermaid diagrams...'); names = renderAll(md, baseName); }
  const html = mdToConfluenceHtml(md, names.map(n => n.fn)) + '<hr/><p><em>Published from markdown by ai-confluence-pipeline (direct).</em></p>';
  const sid = await spaceId(); if (!sid) { console.log('FAIL: could not resolve spaceId for', SPACE_KEY); process.exit(1); }
  const body = { spaceId: sid, status: 'current', title, parentId: String(parentId), body: { representation: 'storage', value: html } };
  const r = await conf('POST', '/wiki/api/v2/pages', body);
  if (r.status >= 300) { console.log('FAIL', r.status, JSON.stringify(r.json).slice(0, 900)); process.exit(1); }
  const pageId = r.json.id;
  console.log('CREATED page', pageId, '|', title, '\n  ', BASE + '/wiki' + (r.json._links?.webui || ''));
  for (const n of names) { const s = uploadAttachment(pageId, n.outPath); console.log('  attach', n.fn, s < 300 ? 'OK' : 'FAIL ' + s); }
} else if (action === 'publish') {
  const pageId = args[0]; const md = fs.readFileSync(args[1], 'utf8');
  const cur = await conf('GET', `/wiki/api/v2/pages/${pageId}`);
  if (cur.status >= 300) { console.log('FAIL get', cur.status); process.exit(1); }
  const title = cur.json.title; const ver = cur.json.version.number + 1;
  const baseName = 'mermaid-' + Date.now().toString(36);
  let names = [];
  if (useMermaid) { console.error('rendering mermaid diagrams...'); names = renderAll(md, baseName); }
  for (const n of names) uploadAttachment(pageId, n.outPath);
  const html = mdToConfluenceHtml(md, names.map(n => n.fn)) + '<hr/><p><em>Published from markdown by ai-confluence-pipeline (direct).</em></p>';
  const body = { id: String(pageId), status: 'current', title, version: { number: ver }, body: { representation: 'storage', value: html } };
  const r = await conf('PUT', `/wiki/api/v2/pages/${pageId}`, body);
  console.log(r.status < 300 ? 'UPDATED ' + pageId + ' → v' + ver : 'FAIL ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 900));
} else { console.log('unknown action:', action); }
