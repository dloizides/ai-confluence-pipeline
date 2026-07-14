#!/usr/bin/env node
/*
 * session-digest.mjs — distil local Claude Code session transcripts into a compact digest.
 *
 * Claude Code writes every session to ~/.claude/projects/<project-slug>/<uuid>.jsonl.
 * Those files are large (100s of MB), but 99% of the bytes are tool traffic we don't need.
 * This script reads them ON DISK and emits only: session title + opening prompt(s) + date span
 * + git branch + Jira keys mentioned. The distilled output is a few KB regardless of raw size —
 * so an agent can read the report without burning tokens on the transcripts themselves.
 *
 * Nothing leaves the machine; it only reads local files.
 *
 * Usage:
 *   node session-digest.mjs [days] [--md] [--html] [--out <path>] [--project <slug>] [--all-projects]
 *
 *   days              lookback window in days (default 14)
 *   --md              write a Markdown report (grouped by week) instead of printing to stdout
 *   --html            write a styled, shareable single-file HTML report
 *   --out <path>      explicit output file (default: Retrospective\session-digest-<today>.<ext>)
 *   --project <slug>  limit to one project dir (default: the SharedProjects project)
 *   --all-projects    scan every project dir under ~/.claude/projects
 *   (no flag)         print the plain text digest to stdout
 *
 * Examples:
 *   node session-digest.mjs 14                 # text digest of the last 14 days to stdout
 *   node session-digest.mjs 14 --md            # Markdown report into the Retrospective folder
 *   node session-digest.mjs 21 --html --out C:\tmp\last3weeks.html
 */

import fs from "fs";
import os from "os";
import path from "path";

// ---- args ---------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith("--")));
const val = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const days = parseInt(argv.find(a => /^\d+$/.test(a)) || "14", 10);
const wantMd = flags.has("--md");
const wantHtml = flags.has("--html");
const projectArg = val("--project");
const allProjects = flags.has("--all-projects");
const outArg = val("--out");

const RETRO_DIR = process.env.SPRINT_RETRO_DIR || "C:/DemetrisLoizidesAll/Retrospective";
const DEFAULT_PROJECT = "C--SharedProjects";
const ROOT = path.join(os.homedir(), ".claude", "projects");

// ---- collect ------------------------------------------------------------
const now = Date.now();
const cutoff = now - days * 86400000;

function projectDirs() {
  if (allProjects) return fs.readdirSync(ROOT).map(d => path.join(ROOT, d)).filter(d => safeIsDir(d));
  const slug = projectArg || DEFAULT_PROJECT;
  const dir = path.join(ROOT, slug);
  return safeIsDir(dir) ? [dir] : [];
}
function safeIsDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

const JIRA_RE = /\bCLS-\d{3,6}\b/g;

function scanSession(fp, projSlug) {
  let title = null, branch = null, first = null, last = null;
  const prompts = [];
  const jira = new Set();
  let turns = 0;
  const data = fs.readFileSync(fp, "utf8").split("\n");
  for (const line of data) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "custom-title" && o.customTitle) title = o.customTitle;
    if (o.gitBranch) branch = o.gitBranch;
    if (o.timestamp) {
      const t = new Date(o.timestamp).getTime();
      if (!Number.isNaN(t)) { if (first === null || t < first) first = t; if (last === null || t > last) last = t; }
    }
    if (o.type === "user" && !o.isMeta && typeof o.message?.content === "string") {
      const c = o.message.content.trim();
      if (c && !c.startsWith("<") && !c.startsWith("[Request")) {
        turns++;
        for (const m of c.match(JIRA_RE) || []) jira.add(m);
        if (prompts.length < 2) prompts.push(c.replace(/\s+/g, " ").slice(0, 200));
      }
    }
  }
  return { proj: projSlug, file: path.basename(fp), title, label: deriveLabel(title, prompts, [...jira]), branch, first, last, prompts, jira: [...jira], turns };
}

// A readable label for the session. Prefer Claude Code's own title, but never surface "(untitled)"
// or a bare Jira number — synthesise a short plain-English label from the first typed prompt instead.
function deriveLabel(title, prompts, jira) {
  const t = (title || "").trim();
  const bareJira = /^CLS-\d{3,6}$/i.test(t);
  if (t && !bareJira && !/^untitled$/i.test(t)) return t;
  let c = (prompts[0] || "").trim();
  c = c.replace(/^[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3}\s+\d{1,2}\/\d{1,2}\/\d{2,4}[^•·-]*[•·-]\s*/i, ""); // drop leading pasted chat "Name 1/2/26 3:45 PM •"
  c = c.replace(/^(ok(ay)?|so|now|listen|hi|hey|right|guys)[,!\s]+/i, "");
  c = c.replace(/^(please\s+)?(can|could|would|will)\s+you\s+(please\s+)?/i, "");
  c = c.replace(/^(your task is to|i want you to|i need you to|i'?d like you to|we need to|we have to|we are to|we want to|let'?s|i think we should|help me|i want|i need)\s+/i, "");
  c = c.replace(/https?:\/\/\S+/gi, "");             // drop URLs
  c = c.replace(/[A-Za-z]:\\[^\s"']+/g, "");         // drop Windows paths
  c = c.replace(/["'`]\s*["'`]/g, " ").replace(/^["'`\s]+/, ""); // collapse now-empty quote pairs
  c = c.replace(/\s+/g, " ").trim();
  let words = c.split(" ").slice(0, 9).join(" ").replace(/[,:;.!]+$/, "");
  if (!words) words = t || "work session";
  let label = words.charAt(0).toUpperCase() + words.slice(1);
  if (label.length > 70) label = label.slice(0, 68).trim() + "…";
  if (bareJira && !label.toUpperCase().includes(t.toUpperCase())) label += ` (${t.toUpperCase()})`;
  return label;
}

const sessions = [];
for (const dir of projectDirs()) {
  const slug = path.basename(dir);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;            // top-level file = a whole session; subagent logs live in subdirs
    const fp = path.join(dir, f);
    let st; try { st = fs.statSync(fp); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    const s = scanSession(fp, slug);
    if (s.first === null) continue;                 // empty / non-conversational file
    sessions.push(s);
  }
}
// Order and bucket by LAST activity: for a sprint report the question is when work HAPPENED, not
// when the thread first opened. A session started before the window but resumed inside it belongs to
// the week it was last touched.
sessions.sort((a, b) => (a.last || 0) - (b.last || 0));

// ---- helpers ------------------------------------------------------------
const iso = ms => {                                 // LOCAL calendar date (avoids UTC off-by-one for late-night work)
  if (!ms) return "?";
  const d = new Date(ms), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function mondayOf(ms) {                              // ISO week start (Monday), local time
  const d = new Date(ms);
  const day = (d.getDay() + 6) % 7;                 // 0 = Monday
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).getTime();
}
function groupByWeek(list) {
  const weeks = new Map();
  for (const s of list) {
    const k = mondayOf(s.last);                     // bucket by last activity
    if (!weeks.has(k)) weeks.set(k, []);
    weeks.get(k).push(s);
  }
  return [...weeks.entries()].sort((a, b) => b[0] - a[0]);   // newest week first
}
function jiraTally(list) {
  const t = new Map();
  for (const s of list) for (const k of s.jira) t.set(k, (t.get(k) || 0) + 1);
  return [...t.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
const TALLY_CAP = 20;      // most-mentioned tickets shown in the roll-up
const PER_SESSION_CAP = 10; // tickets shown per session (long threads mention dozens)
function capKeys(keys, cap) {
  if (keys.length <= cap) return { shown: keys, more: 0 };
  return { shown: keys.slice(0, cap), more: keys.length - cap };
}
const windowFrom = iso(cutoff);                     // the actual "last N days" filter window…
const windowTo = iso(now);
const genDate = iso(now);
// …some included sessions may have STARTED earlier (long/resumed threads); surface that separately
// rather than letting it contradict the "last N days" headline.
const earliestStart = sessions.length ? Math.min(...sessions.map(s => s.first)) : cutoff;
const earliestNote = earliestStart < cutoff ? iso(earliestStart) : null;

// ---- renderers ----------------------------------------------------------
function renderText() {
  const out = [];
  out.push(`# Claude Code sessions — last ${days} days (${sessions.length} sessions)`);
  out.push(`# window ${windowFrom} → ${windowTo}${earliestNote ? `  (some threads started earlier, back to ${earliestNote})` : ""}\n`);
  for (const s of sessions) {
    out.push(`## ${iso(s.last)}  —  ${s.label}`);
    let jiraStr = "";
    if (s.jira.length) { const { shown, more } = capKeys(s.jira, PER_SESSION_CAP); jiraStr = "   jira: " + shown.join(", ") + (more ? ` +${more}` : ""); }
    out.push(`   branch: ${s.branch || "-"}   span: ${iso(s.first)}→${iso(s.last)}   turns: ${s.turns}${jiraStr}`);
    for (const p of s.prompts) out.push(`   ask: ${p}`);
    out.push("");
  }
  return out.join("\n");
}

function renderMd() {
  const out = [];
  out.push(`# Claude Code — Work Digest`);
  out.push(`**Window:** ${windowFrom} → ${windowTo} (last ${days} days) · **${sessions.length} sessions** · generated ${genDate}`);
  if (earliestNote) out.push(`_Some threads were started earlier and resumed in-window (back to ${earliestNote}); sessions are dated & grouped by **last activity**._`);
  out.push("");
  out.push(`> Auto-extracted from local Claude Code session transcripts (titles + opening prompts + Jira keys). Raw transcripts never leave this machine.`);
  out.push("");
  const tally = jiraTally(sessions);
  if (tally.length) {
    out.push(`## Jira touched this window`);
    const top = tally.slice(0, TALLY_CAP);
    let line = top.map(([k, n]) => `\`${k}\`${n > 1 ? ` ×${n}` : ""}`).join(" · ");
    if (tally.length > TALLY_CAP) line += ` · _+${tally.length - TALLY_CAP} more_`;
    out.push(line);
    out.push("");
  }
  for (const [wk, list] of groupByWeek(sessions)) {
    const end = wk + 6 * 86400000;
    out.push(`---`);
    out.push(`## Week of ${DOW[1]} ${iso(wk)} → ${DOW[0]} ${iso(end)}  ·  ${list.length} session${list.length > 1 ? "s" : ""}`);
    out.push("");
    for (const s of list.sort((a, b) => a.last - b.last)) {
      const span = iso(s.first) === iso(s.last) ? iso(s.last) : `${iso(s.first)} → ${iso(s.last)}`;
      out.push(`### ${s.label}  ·  ${span}`);
      const meta = [];
      if (s.jira.length) {
        const { shown, more } = capKeys(s.jira, PER_SESSION_CAP);
        meta.push(`**Jira:** ${shown.map(k => `\`${k}\``).join(", ")}${more ? ` +${more} more` : ""}`);
      }
      meta.push(`**branch:** ${s.branch || "-"}`);
      meta.push(`**turns:** ${s.turns}`);
      out.push(meta.join(" · "));
      for (const p of s.prompts) out.push(`- ${p}`);
      out.push("");
    }
  }
  return out.join("\n");
}

function esc(s) { return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function renderHtml() {
  const tally = jiraTally(sessions);
  let chips = tally.slice(0, TALLY_CAP).map(([k, n]) => `<span class="chip">${esc(k)}${n > 1 ? `<b>×${n}</b>` : ""}</span>`).join("");
  if (tally.length > TALLY_CAP) chips += `<span class="chip more">+${tally.length - TALLY_CAP} more</span>`;
  const weeks = groupByWeek(sessions).map(([wk, list]) => {
    const end = wk + 6 * 86400000;
    const cards = list.sort((a, b) => a.last - b.last).map(s => {
      const span = iso(s.first) === iso(s.last) ? iso(s.last) : `${iso(s.first)} → ${iso(s.last)}`;
      const { shown: jk, more: jm } = capKeys(s.jira, PER_SESSION_CAP);
      const jira = s.jira.length ? `<div class="jira">${jk.map(k => `<span class="chip sm">${esc(k)}</span>`).join("")}${jm ? `<span class="chip sm more">+${jm}</span>` : ""}</div>` : "";
      const asks = s.prompts.map(p => `<li>${esc(p)}</li>`).join("");
      return `<div class="card">
        <div class="card-h"><span class="title">${esc(s.label)}</span><span class="date">${esc(span)}</span></div>
        <div class="meta">branch ${esc(s.branch || "-")} · ${s.turns} turns</div>
        ${jira}
        <ul class="asks">${asks}</ul>
      </div>`;
    }).join("");
    return `<section><h2>Week of Mon ${iso(wk)} → Sun ${iso(end)} <span class="count">${list.length} session${list.length > 1 ? "s" : ""}</span></h2>${cards}</section>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Work Digest ${windowFrom} → ${windowTo}</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--card:#1d212b;--edge:#2a2f3a;--tx:#e7ebf3;--mut:#9aa4b6;--acc:#6ea8fe;--chip:#243043}
@media (prefers-color-scheme:light){:root{--bg:#f5f7fb;--panel:#fff;--card:#fff;--edge:#e2e8f0;--tx:#1a2230;--mut:#5b6577;--acc:#2563eb;--chip:#eaf1ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:24px;margin:0 0 4px}.sub{color:var(--mut);font-size:13px;margin-bottom:20px}
.note{color:var(--mut);font-size:12px;border-left:3px solid var(--edge);padding:6px 12px;margin:0 0 24px}
.tally{background:var(--panel);border:1px solid var(--edge);border-radius:10px;padding:14px 16px;margin-bottom:28px}
.tally h3{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}
.chip{display:inline-block;background:var(--chip);color:var(--acc);border-radius:6px;padding:2px 8px;margin:3px 4px 3px 0;font-size:12px;font-weight:600}
.chip.sm{font-size:11px;padding:1px 6px}.chip b{opacity:.7;font-weight:600;margin-left:3px}
.chip.more{background:transparent;color:var(--mut);font-weight:400}
section{margin-bottom:32px}h2{font-size:15px;border-bottom:1px solid var(--edge);padding-bottom:8px;margin:0 0 14px}
h2 .count{float:right;color:var(--mut);font-weight:400;font-size:13px}
.card{background:var(--card);border:1px solid var(--edge);border-radius:10px;padding:14px 16px;margin-bottom:12px}
.card-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.title{font-weight:700}.date{color:var(--mut);font-size:12px;white-space:nowrap}
.meta{color:var(--mut);font-size:12px;margin:2px 0 8px}.jira{margin-bottom:8px}
ul.asks{margin:0;padding-left:18px}ul.asks li{color:var(--tx);margin:3px 0}
</style></head><body><div class="wrap">
<h1>Claude Code — Work Digest</h1>
<div class="sub">${windowFrom} → ${windowTo} · last ${days} days · ${sessions.length} sessions · generated ${genDate}</div>
<div class="note">Auto-extracted from local Claude Code session transcripts. Raw transcripts never leave this machine.${earliestNote ? ` Some threads were started earlier and resumed in-window (back to ${earliestNote}); dated &amp; grouped by last activity.` : ""}</div>
${tally.length ? `<div class="tally"><h3>Jira touched this window</h3>${chips}</div>` : ""}
${weeks}
</div></body></html>`;
}

// ---- output -------------------------------------------------------------
if (!wantMd && !wantHtml) {
  process.stdout.write(renderText() + "\n");
} else {
  const ext = wantHtml ? "html" : "md";
  const body = wantHtml ? renderHtml() : renderMd();
  const out = outArg || path.join(RETRO_DIR, `session-digest-${genDate}.${ext}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body, "utf8");
  process.stdout.write(`Wrote ${wantHtml ? "HTML" : "Markdown"} report: ${out}\n(${sessions.length} sessions, ${windowFrom} → ${windowTo})\n`);
}
