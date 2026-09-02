#!/usr/bin/env node
// Recover the 8 ITP stories from the wrongly-applied "Cancelled" to "Ready For Deployment"
// (the correct done-category state — they're merged to dev, not deployed). Avoids "Cancel".
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {curlProxyArgs}=require('./proxy.cjs');
const env={};for(const l of fs.readFileSync(path.join(__dirname,'..','.env'),'utf8').split(/\r?\n/)){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].replace(/\s+#.*$/,'').trim();}
const BASE=env.JIRA_BASE_URL,AUTH='Basic '+Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
const PROXY_ARGS=curlProxyArgs(env);
function jira(method,p,body){const a=['-s','-w','\n%{http_code}',...PROXY_ARGS,'-X',method,'-H',`Authorization: ${AUTH}`,'-H','Content-Type: application/json','-H','Accept: application/json'];let tmp=null;if(body){tmp=path.join(os.tmpdir(),`jr-${Date.now()}-${Math.floor(performance.now())}.json`);fs.writeFileSync(tmp,JSON.stringify(body));a.push('--data-binary',`@${tmp}`);}a.push(BASE+p);try{const o=execFileSync('curl',a,{maxBuffer:8*1024*1024}).toString('utf8');const nl=o.lastIndexOf('\n');let j=null;try{j=JSON.parse(o.slice(0,nl));}catch{}return{status:parseInt(o.slice(nl+1),10),j};}finally{if(tmp)try{fs.unlinkSync(tmp);}catch{}}}

const TARGET='Ready For Deployment';
const FORWARD=['Re-Open','Start Work Immediately','Submit for Review','Can be Deployed']; // ordered path; never "Cancel"
function statusOf(k){return jira('GET',`/rest/api/3/issue/${k}?fields=status`).j?.fields?.status?.name;}
function walk(k){
  for(let step=0;step<7;step++){
    const st=statusOf(k);
    if(st===TARGET){console.log(`${k}: ${st} ✓`);return;}
    const ts=jira('GET',`/rest/api/3/issue/${k}/transitions`).j?.transitions||[];
    let chosen=null;
    for(const fname of FORWARD){const t=ts.find(x=>x.name===fname && x.name!=='Cancel');if(t){chosen=t;break;}}
    if(!chosen){console.log(`${k}: stuck at "${st}" — avail: ${ts.map(x=>x.name).join(', ')}`);return;}
    const r=jira('POST',`/rest/api/3/issue/${k}/transitions`,{transition:{id:chosen.id}});
    if(r.status>=300){console.log(`${k}: "${st}" --${chosen.name}--> FAIL ${r.status}`);return;}
  }
  console.log(`${k}: ended at "${statusOf(k)}"`);
}
for(const k of ['CLS-13403','CLS-13404','CLS-13405','CLS-13406','CLS-13407','CLS-13408','CLS-13409','CLS-13410']) walk(k);
