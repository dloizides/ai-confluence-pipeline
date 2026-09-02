#!/usr/bin/env node
// Render a mermaid source string to a tightly-cropped PNG using the system Chrome
// (headless), with the repo's vendored mermaid.min.js. No npm packages, no external egress.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const MERMAID = path.resolve(__dirname, 'vendor/mermaid.min.js'); // repo-vendored, self-contained (no cross-repo path)

const SCALE = 2;          // device pixel ratio, for crispness
const MAX_PHYS = 8000;    // physical px cap per dimension (large Skia surfaces get flaky well before this)
const PAD = 24;           // logical px of whitespace around the svg, so the crop always has margin to keep
const CROP_MARGIN = 24;   // physical px kept around the ink bbox
// Headless Chrome under-paints when the window is sized to exactly fit the content, and the shortfall is
// absolute rather than proportional: a 1228x94 svg painted 13% of its height at an exact fit and 100% at
// +50px. 200 is comfortably past that, and the ink crop removes the slack again.
const SLACK = 200;
// Logical bounds, derived so the physical canvas always stays inside MAX_PHYS. A diagram bigger than this
// is scaled down to fit — never truncated.
const MAX_W = Math.floor(MAX_PHYS / SCALE) - 2 * PAD;
const MAX_H = Math.floor(MAX_PHYS / SCALE) - 2 * PAD - SLACK;

function htmlFor(src, size) {
  const b64 = Buffer.from(src, 'utf8').toString('base64');
  // Pass 1 leaves the svg unsized so mermaid reports its natural viewBox; pass 2 pins it (mermaid writes
  // its own inline max-width/width, so every property needs !important to win).
  const svgCss = size
    ? `#d svg{width:${size.w}px!important;max-width:none!important;height:${size.h}px!important;display:block}`
    : `#d svg{display:block}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#fff}#d{padding:${PAD}px;width:max-content;background:#fff}${svgCss}</style>
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
      { maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  } finally { try { fs.rmSync(udd, { recursive: true, force: true }); } catch {} }
}

/* ---------- minimal PNG codec (zlib only) — just enough to ink-crop a Chrome screenshot ---------- */

let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC_T[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

// Returns { w, h, ch, px }, or ch:0/px:null for anything outside the 8-bit non-interlaced
// greyscale/RGB(A) subset Chrome emits — callers then skip the crop rather than corrupt the file.
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504E47) return null;
  let off = 8, ih = null; const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ih = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ih) return null;
  const ch = CHANNELS[ih.color];
  if (!ch || ih.depth !== 8 || ih.interlace !== 0 || !idat.length) return { w: ih.w, h: ih.h, ch: 0, px: null };

  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return { w: ih.w, h: ih.h, ch: 0, px: null }; }
  const stride = ih.w * ch;
  if (raw.length < (stride + 1) * ih.h) return { w: ih.w, h: ih.h, ch: 0, px: null };

  const px = Buffer.allocUnsafe(stride * ih.h);
  let p = 0;
  for (let y = 0; y < ih.h; y++) {
    const ft = raw[p++], o = y * stride, prev = o - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[o + x - ch] : 0;
      const b = y > 0 ? px[prev + x] : 0;
      const c = (x >= ch && y > 0) ? px[prev + x - ch] : 0;
      let v = raw[p + x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      px[o + x] = v & 0xFF;
    }
    p += stride;
  }
  return { w: ih.w, h: ih.h, ch, px };
}

function pngChunk(type, data) {
  const b = Buffer.allocUnsafe(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}

function encodePng(px, w, h, ch) {
  const stride = w * ch;
  const raw = Buffer.allocUnsafe((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = ch === 1 ? 0 : ch === 2 ? 4 : ch === 3 ? 2 : 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

// Bounding box of everything that isn't background white. null when the image is blank.
function inkBox(img, thr = 248) {
  if (!img || !img.px) return null;
  const { w, h, ch, px } = img, stride = w * ch;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const o = y * stride; let lo = -1, hi = -1;
    for (let x = 0; x < w; x++) {
      const i = o + x * ch;
      const ink = ch === 1 ? px[i] < thr
        : ch === 2 ? (px[i + 1] > 16 && px[i] < thr)
          : ch === 3 ? (px[i] < thr || px[i + 1] < thr || px[i + 2] < thr)
            : (px[i + 3] > 16 && (px[i] < thr || px[i + 1] < thr || px[i + 2] < thr));
      if (ink) { if (lo < 0) lo = x; hi = x; }
    }
    if (hi >= 0) { if (y0 > y) y0 = y; y1 = y; if (lo < x0) x0 = lo; if (hi > x1) x1 = hi; }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Size + ink bbox of a PNG on disk. Used by render() and by the verification tooling.
function inspectPng(file) {
  const img = decodePng(fs.readFileSync(file));
  return img ? { w: img.w, h: img.h, decoded: !!img.px, ink: inkBox(img) } : null;
}

// Crops `file` in place to its ink plus CROP_MARGIN, returning the PRE-crop stats. A PNG we can't
// decode, or one that is entirely blank, is left untouched (loose canvas beats a corrupt file).
function cropInPlace(file) {
  const img = decodePng(fs.readFileSync(file));
  if (!img) return null;
  const stats = { w: img.w, h: img.h, decoded: !!img.px, ink: inkBox(img), cropped: false };
  if (!img.px || !stats.ink) return stats;
  const { ch, px, w } = img;
  const x0 = Math.max(0, stats.ink.x0 - CROP_MARGIN), y0 = Math.max(0, stats.ink.y0 - CROP_MARGIN);
  const x1 = Math.min(img.w - 1, stats.ink.x1 + CROP_MARGIN), y1 = Math.min(img.h - 1, stats.ink.y1 + CROP_MARGIN);
  const cw = x1 - x0 + 1, cropH = y1 - y0 + 1;
  if (cw === img.w && cropH === img.h) return stats;
  const outPx = Buffer.allocUnsafe(cw * cropH * ch);
  for (let y = 0; y < cropH; y++) px.copy(outPx, y * cw * ch, ((y0 + y) * w + x0) * ch, ((y0 + y) * w + x1 + 1) * ch);
  fs.writeFileSync(file, encodePng(outPx, cw, cropH, ch));
  stats.cropped = true;
  return stats;
}

/* ---------------------------------------- render ---------------------------------------- */

function render(src, outPng) {
  const tmp1 = path.join(os.tmpdir(), `mmd-${process.pid}-${Date.now()}-a.html`);
  const tmp2 = tmp1.replace(/-a\.html$/, '-b.html');
  fs.writeFileSync(tmp1, htmlFor(src, null), 'utf8');
  try {
    // Pass 1 — dump DOM and read the svg's own viewBox: that is the diagram's natural size.
    const dom = chrome(['--dump-dom', `file:///${tmp1.replace(/\\/g, '/')}`]).toString('utf8');
    const vb = dom.match(/viewBox=["']0 0 ([\d.]+) ([\d.]+)["']/);
    const vbW = vb ? parseFloat(vb[1]) : 1400;
    const vbH = vb ? parseFloat(vb[2]) : Math.round(1400 * 0.62);

    // Render at the diagram's own size — never upscaled, shrunk only to stay inside the bounds.
    let w = Math.max(1, Math.min(MAX_W, Math.round(vbW)));
    let h = Math.max(1, Math.round(vbH * (w / vbW)));
    if (h > MAX_H) { w = Math.max(1, Math.round(w * (MAX_H / h))); h = MAX_H; }
    const winW = Math.max(200, w + 2 * PAD);
    const winH = Math.max(200, h + 2 * PAD + SLACK);

    // Pass 2 — screenshot with the svg pinned to that size in a window with slack, then ink-crop.
    fs.writeFileSync(tmp2, htmlFor(src, { w, h }), 'utf8');
    chrome([`--screenshot=${outPng}`, `--window-size=${winW},${winH}`,
      `--force-device-scale-factor=${SCALE}`, `file:///${tmp2.replace(/\\/g, '/')}`]);
    const vbStr = vb ? `${vb[1]}x${vb[2]}` : 'none';
    if (!fs.existsSync(outPng)) return { ok: false, height: winH, vb: vbStr };

    const pre = cropInPlace(outPng);
    const post = inspectPng(outPng);
    return {
      ok: true, height: winH, vb: vbStr,
      width: w, rendered: `${w}x${h}`, scale: SCALE, window: `${winW}x${winH}`,
      canvas: pre ? `${pre.w}x${pre.h}` : 'unknown',
      ink: pre && pre.ink ? `${pre.ink.w}x${pre.ink.h}@${pre.ink.x0},${pre.ink.y0}` : 'none',
      png: post ? `${post.w}x${post.h}` : 'unknown',
      cropped: !!(pre && pre.cropped),
    };
  } finally { for (const t of [tmp1, tmp2]) { try { fs.unlinkSync(t); } catch {} } }
}

module.exports = { render, inspectPng, decodePng, inkBox };

// CLI: render_mermaid.cjs <srcFile> <outPng>
if (require.main === module) {
  if (!CHROME) { console.error('No Chrome/Edge found'); process.exit(1); }
  const [srcFile, outPng] = process.argv.slice(2);
  const r = render(fs.readFileSync(srcFile, 'utf8'), path.resolve(outPng));
  console.log(JSON.stringify(r));
}
