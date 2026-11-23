'use strict';
// Generates the Minimail app icon with zero image dependencies:
// hard-edged shapes at 4x supersampling, box-downsampled to smooth AA.
// Output: build/icon.png (512) and build/icon.ico (16..256, PNG-compressed).
const fs = require('node:fs');
const path = require('node:path');
const { encodePng } = require('../src/png');

const S = 512; // design space
const SS = 4;  // supersample factor

function inRoundedRect(px, py, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// The design: a blue tile carrying a white envelope whose fold is cut back out
// of it. Blue rather than dark because the taskbar it sits on usually is dark.
// Other candidates (a white tile, an "M") are kept in scripts/icon-concepts.js.
function tileColor(y) {
  const t = Math.max(0, Math.min(1, (y - 16) / 480));
  return [Math.round(lerp(125, 47, t)), Math.round(lerp(179, 109, t)), Math.round(lerp(255, 224, t))]; // #7db3ff -> #2f6de0
}

function sample(dx, dy) {
  if (!inRoundedRect(dx, dy, 16, 16, 496, 496, 112)) return [0, 0, 0, 0];
  const tile = tileColor(dy);
  if (inRoundedRect(dx, dy, 128, 168, 384, 344, 22)) {
    // the fold of the flap, carved back out in the tile's colour
    const d = Math.min(distSeg(dx, dy, 138, 186, 256, 282), distSeg(dx, dy, 256, 282, 374, 186));
    if (d > 12) return [255, 255, 255, 255];
  }
  return [tile[0], tile[1], tile[2], 255];
}

function render(n) {
  const out = Buffer.alloc(n * n * 4);
  for (let oy = 0; oy < n; oy++) {
    for (let ox = 0; ox < n; ox++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let iy = 0; iy < SS; iy++) {
        for (let ix = 0; ix < SS; ix++) {
          const dx = ((ox + (ix + 0.5) / SS) * S) / n;
          const dy = ((oy + (iy + 0.5) / SS) * S) / n;
          const [cr, cg, cb, ca] = sample(dx, dy);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const i = (oy * n + ox) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round(a / (SS * SS));
    }
  }
  return out;
}

function buildIco(sizes) {
  const pngs = sizes.map((n) => encodePng(n, render(n)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const entries = [];
  let offset = 6 + sizes.length * 16;
  sizes.forEach((n, i) => {
    const e = Buffer.alloc(16);
    e[0] = n >= 256 ? 0 : n; // 0 means 256
    e[1] = n >= 256 ? 0 : n;
    e.writeUInt16LE(1, 4); // PNG
    e.writeUInt16LE(32, 6); // color depth (nominal)
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += pngs[i].length;
  });
  return Buffer.concat([header, ...entries, ...pngs]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const sizes = [16, 24, 32, 48, 64, 128, 256];
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(sizes));
fs.writeFileSync(path.join(outDir, 'icon.png'), encodePng(512, render(512)));
// The same design, small, for the title bar of the shell and Settings windows.
for (const dir of ['shell', 'settings']) fs.writeFileSync(path.join(__dirname, '..', 'src', dir, 'logo.png'), encodePng(64, render(64)));
console.log('icons written:', sizes.join(', '), '+ 512px png ->', outDir, '| title-bar logo -> src/shell, src/settings');
