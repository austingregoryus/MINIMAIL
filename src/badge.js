'use strict';
// Numbered taskbar overlay icons with zero native dependencies: a tiny
// RGBA rasterizer plus a minimal PNG encoder (zlib comes from Node core).

const { nativeImage } = require('electron');
const { encodePng } = require('./png');

const SIZE = 32; // OS scales down to the 16px overlay slot
const RED = [234, 67, 53]; // #ea4335
const FONT = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '011', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};

function rasterize(label) {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  // src-over composite, keeps digits crisp over the disc's anti-aliased edge
  const put = (x, y, r, g, b, a) => {
    const i = (y * SIZE + x) * 4;
    const na = a / 255;
    const oa = px[i + 3] / 255;
    const outA = na + oa * (1 - na);
    if (!outA) return;
    px[i] = Math.round((r * na + px[i] * oa * (1 - na)) / outA);
    px[i + 1] = Math.round((g * na + px[i + 1] * oa * (1 - na)) / outA);
    px[i + 2] = Math.round((b * na + px[i + 2] * oa * (1 - na)) / outA);
    px[i + 3] = Math.round(outA * 255);
  };

  const c = (SIZE - 1) / 2;
  const radius = SIZE / 2 - 1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const a = Math.max(0, Math.min(255, Math.round((radius - Math.hypot(x - c, y - c) + 0.5) * 255)));
      if (a > 0) put(x, y, RED[0], RED[1], RED[2], a);
    }
  }

  const s = label.length > 1 ? 2 : 3; // pixel scale of the 3x5 micro-font
  const gap = 1;
  const width = label.length * 3 * s + (label.length - 1) * gap;
  const height = 5 * s;
  let x0 = Math.round(c - width / 2);
  const y0 = Math.round(c - height / 2);
  for (const ch of label) {
    const glyph = FONT[ch];
    if (glyph) {
      for (let r = 0; r < 5; r++) {
        for (let col = 0; col < 3; col++) {
          if (glyph[r][col] === '1') {
            for (let dy = 0; dy < s; dy++) {
              for (let dx = 0; dx < s; dx++) put(x0 + col * s + dx, y0 + r * s + dy, 255, 255, 255, 255);
            }
          }
        }
      }
    }
    x0 += 3 * s + gap;
  }
  return px;
}

const cache = new Map();
function badgeImage(n) {
  if (!n || n <= 0) return null;
  const label = String(n > 99 ? 99 : n);
  let img = cache.get(label);
  if (!img) {
    img = nativeImage.createFromBuffer(encodePng(SIZE, rasterize(label)));
    cache.set(label, img);
  }
  return img;
}

module.exports = { badgeImage, dotImage };

// A plain coloured disc for the "add an account" menu, one per mail service.
const DOT = 16;
const dots = new Map();
function dotImage(color) {
  let img = dots.get(color);
  if (!img) {
    const px = Buffer.alloc(DOT * DOT * 4);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    const c = (DOT - 1) / 2;
    const radius = DOT / 2 - 0.5;
    for (let y = 0; y < DOT; y++) {
      for (let x = 0; x < DOT; x++) {
        const a = Math.max(0, Math.min(255, Math.round((radius - Math.hypot(x - c, y - c) + 0.5) * 255)));
        const i = (y * DOT + x) * 4;
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
        px[i + 3] = a;
      }
    }
    img = nativeImage.createFromBuffer(encodePng(DOT, px));
    dots.set(color, img);
  }
  return img;
}
