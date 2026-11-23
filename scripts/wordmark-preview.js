'use strict';
// Renders wordmark candidates to a PNG so they can be compared at the sizes
// they would actually be seen at. Local HTML only: no network, no profile.
//   node_modules/.bin/electron scripts/wordmark-preview.js <out.png>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.setPath('userData', path.join(os.tmpdir(), 'wordmark-preview')); // never the app's own profile

const I = '<span class="i">I</span>';
const rows = [
  ['square brackets', `MINIMA<span class="p">[</span>${I}<span class="p">]</span>L`],
  ['parentheses', `MINIMA<span class="p">(</span>${I}<span class="p">)</span>L`],
  ['parentheses, dimmed', `MINIMA<span class="dim">(</span>${I}<span class="dim">)</span>L`],
  ['no punctuation, accent letter', `MINIMA<span class="accent">I</span>L`],
  ['no punctuation, thin letter', `MINIMA<span class="thin">I</span>L`],
  ['plain, for reference', 'MINIMAIL'],
];

const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; padding: 28px 36px; background: #141519; color: #e8eaed; font-family: 'Segoe UI', system-ui, sans-serif; }
  table { border-collapse: collapse; }
  td { padding: 10px 0; vertical-align: middle; border-bottom: 1px solid #23252b; }
  td.cap { width: 230px; font-size: 12px; color: #9aa0a6; }
  .big { font-size: 54px; font-weight: 600; letter-spacing: 1px; line-height: 1.1; width: 480px; }
  .mid { font-size: 20px; font-weight: 600; letter-spacing: .5px; width: 170px; }
  .small { font-size: 12px; color: #9aa0a6; width: 150px; }
  th { text-align: left; font-size: 11px; font-weight: 400; color: #5f6368; padding: 0 0 6px; text-transform: uppercase; letter-spacing: .08em; }
  .p, .dim { color: #5f6368; }
  .accent { color: #8ab4f8; }
  .thin { font-weight: 200; color: #8ab4f8; }
</style>
<table>
  <tr><th></th><th>welcome screen, 54px</th><th>settings, 20px</th><th>title bar, 12px</th></tr>
  ${rows
    .map(
      ([cap, mark]) =>
        `<tr><td class="cap">${cap}</td><td class="big">${mark}</td><td class="mid">${mark}</td><td class="small">${mark.replace(/class="[a-z]+"/g, '')}</td></tr>`,
    )
    .join('\n')}
</table>`;

app.whenReady().then(async () => {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: electron scripts/wordmark-preview.js <out.png>');
    return app.exit(2);
  }
  const win = new BrowserWindow({ width: 1060, height: 560, show: false, backgroundColor: '#141519' });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((resolve) => setTimeout(resolve, 600));
  fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
  console.log('saved ' + out);
  app.exit(0);
});
