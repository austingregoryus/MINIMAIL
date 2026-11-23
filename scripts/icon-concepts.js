'use strict';
// Renders app-icon candidates to a contact sheet, so they can be compared at
// the sizes they will actually be seen at. Pure Node, no image dependencies.
//   node scripts/icon-concepts.js <out.png>
const fs = require('node:fs');
const path = require('node:path');
const { encodePngRect } = require('../src/png');

const S = 512; // design space
const SS = 4; // supersampling factor

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function inRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = clamp(px, x0 + r, x1 - r);
  const cy = clamp(py, y0 + r, y1 - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// A thick line with round ends.
const inStroke = (px, py, ax, ay, bx, by, w) => distSeg(px, py, ax, ay, bx, by) <= w / 2;

const inTile = (px, py) => inRoundRect(px, py, 16, 16, 496, 496, 112);
const tileGradient = (py, top, bottom) => mix(top, bottom, clamp((py - 16) / 480, 0, 1));

// The envelope: a filled body with the fold of its flap drawn on top.
const BODY = [128, 168, 384, 344];
const inBody = (px, py) => inRoundRect(px, py, ...BODY, 22);
const onFlap = (px, py) => inStroke(px, py, 138, 186, 256, 282, 24) || inStroke(px, py, 256, 282, 374, 186, 24);

const BLUE = [[125, 179, 255], [47, 109, 224]]; // tile, top to bottom
const WHITE = [[248, 250, 255], [226, 232, 244]];
const DARK = [[44, 46, 54], [22, 23, 28]];
const INK = [31, 35, 41];
const ACCENT = [138, 180, 248];
const SIGNAL = [59, 130, 246];

// Each concept: a function from design-space point to [r, g, b, a].
const CONCEPTS = [
  {
    id: 'A',
    name: 'Blue tile, white envelope',
    sample(px, py) {
      if (!inTile(px, py)) return [0, 0, 0, 0];
      let c = tileGradient(py, ...BLUE);
      if (inBody(px, py) && !onFlap(px, py)) c = [255, 255, 255];
      return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255];
    },
  },
  {
    id: 'B',
    name: 'White tile, dark envelope, blue fold',
    sample(px, py) {
      if (!inTile(px, py)) return [0, 0, 0, 0];
      let c = tileGradient(py, ...WHITE);
      if (inBody(px, py)) c = onFlap(px, py) ? SIGNAL : INK;
      return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255];
    },
  },
  {
    // An envelope is a rectangle with a V on top; so is the middle of an M.
    id: 'C',
    name: 'Blue tile, white M (the V of the flap is the middle of the letter)',
    sample(px, py) {
      if (!inTile(px, py)) return [0, 0, 0, 0];
      const c = tileGradient(py, ...BLUE);
      const W_ = 50;
      const m =
        inStroke(px, py, 136, 372, 136, 156, W_) ||
        inStroke(px, py, 376, 372, 376, 156, W_) ||
        inStroke(px, py, 136, 170, 256, 318, W_) ||
        inStroke(px, py, 376, 170, 256, 318, W_);
      return m ? [255, 255, 255, 255] : [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255];
    },
  },
];

function render(sample, n) {
  const out = Buffer.alloc(n * n * 4);
  for (let oy = 0; oy < n; oy++) {
    for (let ox = 0; ox < n; ox++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let iy = 0; iy < SS; iy++) {
        for (let ix = 0; ix < SS; ix++) {
          const [cr, cg, cb, ca] = sample(((ox + (ix + 0.5) / SS) * S) / n, ((oy + (iy + 0.5) / SS) * S) / n);
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
  return { n, px: out };
}

// --- contact sheet -------------------------------------------------------------------------
const W = 560;
const ROW = 128;
const PANEL = ROW * CONCEPTS.length + 76; // concept rows + a simulated taskbar strip
const H = PANEL * 2;
const sheet = Buffer.alloc(W * H * 4);
const LIGHT = [243, 243, 243];
const DARKBAR = [32, 32, 32];
const LIGHTBAR = [238, 238, 238];

function fill(x, y, w, h, rgb) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const i = (yy * W + xx) * 4;
    sheet[i] = rgb[0];
    sheet[i + 1] = rgb[1];
    sheet[i + 2] = rgb[2];
    sheet[i + 3] = 255;
  }
}

function blit(icon, x, y) {
  const { n, px } = icon;
  for (let yy = 0; yy < n; yy++) for (let xx = 0; xx < n; xx++) {
    const s = (yy * n + xx) * 4;
    const a = px[s + 3] / 255;
    if (!a) continue;
    const i = ((y + yy) * W + x + xx) * 4;
    for (let k = 0; k < 3; k++) sheet[i + k] = Math.round(px[s + k] * a + sheet[i + k] * (1 - a));
  }
}

const SIZES = [96, 48, 32, 24, 16];
for (const [panel, bg, bar] of [[0, LIGHT, DARKBAR], [1, DARKBAR, LIGHTBAR]]) {
  const top = panel * PANEL;
  fill(0, top, W, PANEL, bg);
  CONCEPTS.forEach((concept, row) => {
    const y = top + 16 + row * ROW;
    let x = 24;
    for (const n of SIZES) {
      blit(render(concept.sample, n), x, y + Math.round((96 - n) / 2));
      x += n + 28;
    }
  });
  // A strip the colour of the other theme's taskbar, with the icons at taskbar size.
  const stripY = top + PANEL - 60;
  fill(0, stripY, W, 60, bar);
  CONCEPTS.forEach((concept, row) => {
    blit(render(concept.sample, 24), 28 + row * 232, stripY + 12);
    blit(render(concept.sample, 16), 28 + row * 232 + 48, stripY + 17);
  });
}

const out = process.argv[2] || path.join(__dirname, '..', 'build', 'icon-concepts.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePngRect(W, H, sheet));
console.log('concepts:', CONCEPTS.map((c) => `${c.id} = ${c.name}`).join(' | '));
console.log('written:', out, `(${W}x${H})`);

// --- text previews (16px, two characters per pixel so the cells stay square) ---------------
// White is left blank, mid tones are shaded and dark tones are solid, so the
// white parts of an icon read as cut-outs of its tile.
const ruler = '+' + '-'.repeat(34) + '+';
for (const concept of CONCEPTS) {
  const { n, px } = render(concept.sample, 16);
  const lines = [];
  for (let y = 0; y < n; y++) {
    let line = '';
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      if (px[i + 3] < 128) line += '  ';
      else {
        const luma = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        line += luma > 225 ? '  ' : luma > 90 ? '\u2591\u2591' : '\u2588\u2588';
      }
    }
    lines.push('|' + line.padEnd(34) + '|');
  }
  console.log(`\n[${concept.id}] ${concept.name}\n${ruler}\n${lines.join('\n')}\n${ruler}`);
}
