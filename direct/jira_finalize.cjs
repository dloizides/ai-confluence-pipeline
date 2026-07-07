#!/usr/bin/env node
// CLS-13400 finalization: close delivered stories, split 13410 (new leftovers story), update epic Reference Documents.
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const env = {}; for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/\s+#.*$/, '').trim(); }
const BASE = env.JIRA_BASE_URL, AUTH = 'Basic ' + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64'), PROXY = 'occyproxy.odysseycs.com:8080';
function jira(method, p, body) { const a = ['-s','-w','\n%{http_code}','--proxy',PROXY,'-X',method,'-H',`Authorization: ${AUTH}`,'-H','Content-Type: application/json','-H','Accept: application/json']; let tmp=null; if(body){tmp=path.join(os.tmpdir(),`jf-${Date.now()}-${Math.floor(performance.now())}.json`);fs.writeFileSync(tmp,JSON.stringify(body));a.push('--data-binary',`@${tmp}`);} a.push(BASE+p); try{const o=execFileSync('curl',a,{maxBuffer:8*1024*1024}).toString('utf8');const nl=o.lastIndexOf('\n');let j=null;try{j=JSON.parse(o.slice(0,nl));}catch{}return{status:parseInt(o.slice(nl+1),10),j,raw:o.slice(0,nl)};}finally{if(tmp)try{fs.unlinkSync(tmp);}catch{}} }

const WIKI = 'https://clearskies.atlassian.net/wiki/spaces';
const text=(t,marks)=>marks?{type:'text',text:t,marks}:{type:'text',text:t};
const link=(t,href)=>({type:'text',text:t,marks:[{type:'link',attrs:{href}}]});
const para=(...n)=>({type:'paragraph',content:n.flat()});
const heading=(lvl,t)=>({type:'heading',attrs:{level:lvl},content:[text(t)]});
const li=(...n)=>({type:'listItem',content:[para(...n)]});
const bullets=(items)=>({type:'bulletList',content:items});
const doc=(content)=>({type:'doc',version:1,content});

const me = jira('GET','/rest/api/3/myself').j.accountId;
console.log('self:', me);

// 1) Create the leftovers story under CLS-13400
const storyDesc = doc([
  para(text('Split out from CLS-13410. The five Activity-tab endpoints (summary/alerts/ueba/etmr/ti) are implemented and merged to dev; this story tracks the two enrichment fields that need a confirmed data source before they can be wired.')),
  para(text('B2 — ETMR detections (GET /itp/users/{userId}/activity/etmr): endpoint returns [] today. Confirm the source table/engine (likely the Endpoint* family: EndpointBehaviorApplicationAnomaly + EndpointDetectionCategory) and the device→user join (via the B1 UEBA-relation link).')),
  para(text('B3 — TI indicator + tacticTags (GET /itp/users/{userId}/activity/ti): the TI hits and the indicator value already work; confirm which Taxii tag table (Tag / TagMapping / TTP / EntityKillChainPhase) holds the MITRE tactic labels to populate tacticTags.')),
  para(text('Context, where the data lives, and the gap diagram: '), link('Open Questions / Data-Wiring Blockers (B2/B3)', `${WIKI}/CSDevs/pages/1039007745`), text('.')),
  heading(3,'Acceptance Criteria'),
  bullets([
    li(text('activity/etmr returns the user’s ETMR detections with sourceEngine + sourceCategory populated from the confirmed source')),
    li(text('activity/ti items include indicator and tacticTags from the confirmed Taxii pattern/tag tables')),
    li(text('ETMR device→user resolution reuses the B1 UEBA-relation link')),
  ]),
]);
const sres = jira('POST','/rest/api/3/issue',{fields:{project:{key:'CLS'},issuetype:{name:'Story'},parent:{key:'CLS-13400'},summary:'[WS] ITP Activity tab — ETMR + TI enrichment (pending B2/B3 source confirmation)',description:storyDesc,labels:['ai-pipeline-generated'],...(me?{assignee:{accountId:me},reporter:{accountId:me}}:{})}});
const newKey = sres.j?.key;
console.log('new story:', sres.status, newKey, sres.status>=300?JSON.stringify(sres.j).slice(0,500):'');

// 2) Comment on 13410 noting the split
if(newKey){ const c = jira('POST','/rest/api/3/issue/CLS-13410/comment',{body:doc([para(text('Split: the five Activity-tab endpoints are delivered and merged to dev (this ticket). ETMR + TI enrichment moved to '),link(newKey,`${BASE}/browse/${newKey}`),text(' — blocked on B2/B3 source confirmation.'))])}); console.log('13410 comment:', c.status); }

// 3) Update epic CLS-13400 description (Reference Documents + status)
const epicDesc = doc([
  para(text('Backend implementation of the Identity Threat Protection (ITP) module for ClearSkies 2.0 — the Itp CQRS module, all /itp API endpoints, data-model changes, and Redis cache. Taskron jobs are in the sibling epic CLS-13738.')),
  para(text('Status (2026-06-27): WS backend implemented, live-verified on dev, and merged to dev. Stories CLS-13403–13409 Done; CLS-13410 split — the five Activity-tab endpoints delivered & merged, with ETMR + TI enrichment tracked in '), newKey?link(newKey,`${BASE}/browse/${newKey}`):text('a follow-up story'), text(' pending source confirmation.')),
  heading(3,'Reference Documents'),
  bullets([
    li(link('BA — Identity Threat Protection', `${WIKI}/RD1/pages/948207617`)),
    li(link('BE-FE Contract', `${WIKI}/CSDevs/pages/981925890`)),
    li(link('Backend Technical Analysis', `${WIKI}/CSDevs/pages/982024194`)),
    li(link('Backend Data Flows (DB / Redis / Impala diagrams)', `${WIKI}/CSDevs/pages/1038581763`)),
    li(link('FE Notes & Endpoint Test Curls', `${WIKI}/CSDevs/pages/1038974978`)),
    li(link('Open Questions, Assumptions & Pending Work', `${WIKI}/CSDevs/pages/1039007745`)),
    li(link('Database Migration Guide', `${WIKI}/CSDevs/pages/1039073299`)),
    li(link('SRV-M-012 — Whole-table load by a translatable key', `${WIKI}/CSDevs/pages/1039400962`)),
  ]),
]);
const eres = jira('PUT','/rest/api/3/issue/CLS-13400',{fields:{description:epicDesc}});
console.log('epic update:', eres.status, eres.status>=300?JSON.stringify(eres.j).slice(0,500):'OK');

// 4) Transition delivered stories -> Done
function done(key){ const tr=jira('GET',`/rest/api/3/issue/${key}/transitions`); const ts=tr.j?.transitions||[]; const t=ts.find(x=>x.to?.statusCategory?.key==='done')||ts.find(x=>/done|complete|resolve|close/i.test(x.name)); if(!t){console.log(`${key}: no Done transition (avail: ${ts.map(x=>x.name).join(', ')})`);return;} const r=jira('POST',`/rest/api/3/issue/${key}/transitions`,{transition:{id:t.id}}); console.log(`${key}: ${t.name} -> ${r.status}`); }
for(const k of ['CLS-13403','CLS-13404','CLS-13405','CLS-13406','CLS-13407','CLS-13408','CLS-13409','CLS-13410']) done(k);
