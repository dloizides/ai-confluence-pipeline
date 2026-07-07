#!/usr/bin/env node
// Render a mermaid source string to a tightly-cropped PNG using the system Chrome
// (headless), with the repo's vendored mermaid.min.js. No npm packages, no external egress.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const MERMAID = path.resolve(__dirname, 'vendor/mermaid.min.js'); // repo-vendored, self-contained (no cross-repo path)
const WIDTH = 1400; // logical render width; height derived from the SVG viewBox

function htmlFor(src) {
  const b64 = Buffer.from(src, 'utf8').toString('base64');
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#fff}#d{width:${WIDTH}px}#d svg{width:${WIDTH}px;height:auto;display:block}</style>
<script src="file:///${MERMAID.replace(/\\/g, '/')}"></script></head>
<body><div id="d" class="mermaid">PLACEHOLDER</div>
<script>
  const src = new TextDecoder('utf-8').decode(Uint8Array.from(atob("${b64}"), c => c.charCodeAt(0)));
  document.getElementById('d').textContent = src;
  mermaid.initialize({startOnLoad:false, securityLevel:'loose', flowchart:{htmlLabels:false}, theme:'default'});
  window.__done = false;
  mermaid.run({nodes:[document.getElementById('d')]}).then(()=>{ window.__done = true; document.title = 'READY'; });
</script></body></html>`;
}

function chrome(args) {
  // Dedicated throwaway profile per invocation — otherwise, when the user already has Chrome open on
  // the default profile, `--headless=new` attaches to that running singleton and never returns/writes.
  const udd = path.join(os.tmpdir(), `cr-mmd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    return execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--allow-file-access-from-files', '--hide-scrollbars', '--virtual-time-budget=20000',
      `--user-data-dir=${udd}`, '--default-background-color=FFFFFFFF', ...args],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
  } finally { try { fs.rmSync(udd, { recursive: true, force: true }); } catch {} }
}

function render(src, outPng) {
  const tmp = path.join(os.tmpdir(), `mmd-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(tmp, htmlFor(src), 'utf8');
  try {
    // Pass 1 — dump DOM, read the SVG viewBox to get the aspect ratio.
    const dom = chrome(['--dump-dom', `file:///${tmp.replace(/\\/g, '/')}`]).toString('utf8');
    const vb = dom.match(/viewBox=["']0 0 ([\d.]+) ([\d.]+)["']/);
    let height = Math.round(WIDTH * 0.62);
    if (vb) height = Math.max(80, Math.round(WIDTH * (parseFloat(vb[2]) / parseFloat(vb[1]))) + 16);
    // Pass 2 — screenshot at the computed window size, 2× for crispness.
    chrome([`--screenshot=${outPng}`, `--window-size=${WIDTH},${height}`,
      '--force-device-scale-factor=2', `file:///${tmp.replace(/\\/g, '/')}`]);
    return { ok: fs.existsSync(outPng), height, vb: vb ? `${vb[1]}x${vb[2]}` : 'none' };
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

module.exports = { render };

// CLI: render_mermaid.cjs <srcFile> <outPng>
if (require.main === module) {
  if (!CHROME) { console.error('No Chrome/Edge found'); process.exit(1); }
  const [srcFile, outPng] = process.argv.slice(2);
  const r = render(fs.readFileSync(srcFile, 'utf8'), path.resolve(outPng));
  console.log(JSON.stringify(r));
}
