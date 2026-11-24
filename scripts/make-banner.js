'use strict';
// Renders the README's title banner from the app's own pieces — the logo, the
// wordmark, the service marks and colours — so it can be made again whenever
// they change. Local files only: no network, no profile.
//   npm run banner        -> docs/media/banner.png (2544x800)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const marks = require('../src/marks');
const { PROVIDERS, PROVIDER_ORDER } = require('../src/providers');

app.setPath('userData', path.join(os.tmpdir(), 'minimail-banner')); // never the app's own profile
app.commandLine.appendSwitch('force-device-scale-factor', '2'); // crisp on high-density screens

const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png')).toString('base64');
const OUTLINE = /^[MmZzLlHhVvCcSsQqTtAaEe][MmZzLlHhVvCcSsQqTtAaEe0-9.,\s+-]*$/;
const svg = (d, size) => (OUTLINE.test(d) ? `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${d}"/></svg>` : null);

// A service's badge, as the sidebar draws it: its outline in its colour, or
// its initial where it has no outline.
function badge(id, size) {
  const provider = PROVIDERS[id];
  const dot = size * 0.56;
  const inner = Math.round(size * 0.3);
  const mark = provider.mark && svg(provider.mark, inner);
  return `<span class="dot" style="width:${dot}px;height:${dot}px;background:${provider.color}">${mark || `<span style="font-size:${Math.round(inner * 0.9)}px">${(provider.short || provider.name)[0]}</span>`}</span>`;
}

const chips = PROVIDER_ORDER.filter((id) => PROVIDERS[id])
  .filter((id) => id !== 'outlook-work') // the same badge as "outlook": one chip says Outlook
  .map((id) => `<span class="chip">${badge(id, 32)}${PROVIDERS[id].short || PROVIDERS[id].name}</span>`)
  .join('');

// The window on the right is a sketch of the real one, with the real geometry:
// a 40px title bar, a 56px sidebar of 40px accounts with a 17px service badge.
const accounts = [
  ['A', '#3b6fd4', 'gmail', true],
  ['S', '#2e8b6f', 'gmail', false],
  ['R', '#6d4aff', 'proton', false],
];
const rows = Array.from({ length: 6 }, (_, i) => {
  const w1 = [46, 38, 52, 33, 44, 40][i];
  const w2 = [78, 64, 70, 58, 72, 66][i];
  return `<div class="row${i === 0 ? ' unread' : ''}"><span class="ava"></span><div class="bars"><i style="width:${w1}%"></i><i style="width:${w2}%"></i></div></div>`;
}).join('');

const html = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; overflow: hidden; }
  /* Fixed canvas. (A hidden window's page comes out 1272x400 here, so that is the canvas.) */
  .canvas { position: relative; width: 1272px; height: 400px; overflow: hidden; background: #141519; color: #e8eaed;
    font-family: 'Segoe UI', 'Segoe UI Variable Text', system-ui, sans-serif; }
  .glow { position: absolute; inset: 0;
    background: radial-gradient(760px 460px at 86% -30%, rgba(47, 109, 224, .34), transparent 62%),
                radial-gradient(620px 380px at -8% 128%, rgba(138, 180, 248, .10), transparent 62%); }
  .left { position: absolute; left: 72px; top: 58px; width: 660px; }
  .brand { display: flex; align-items: center; gap: 24px; }
  .logo { width: 96px; height: 96px; border-radius: 22px; box-shadow: 0 12px 34px rgba(47, 109, 224, .38); }
  .word { font-size: 80px; font-weight: 600; letter-spacing: .5px; line-height: 1; }
  .word .i { color: #8ab4f8; }
  .tag { margin: 24px 0 0; font-size: 31px; font-weight: 400; color: #bdc1c6; line-height: 1.3; }
  .tag b { color: #e8eaed; font-weight: 600; }
  .chips { margin-top: 28px; display: flex; flex-wrap: wrap; gap: 10px; }
  .chip { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 15px 0 7px; border-radius: 18px;
    background: #1d1f25; border: 1px solid #2b2e36; font-size: 15px; color: #c4c7cc; }
  .dot { display: grid; place-items: center; border-radius: 50%; color: #fff; font-weight: 700; line-height: 1; }
  .dot svg { fill: #fff; display: block; }

  .mock { position: absolute; right: 64px; top: 44px; width: 412px; height: 312px; border-radius: 14px; overflow: hidden;
    background: #17181c; border: 1px solid #2b2e36; box-shadow: 0 28px 70px rgba(0, 0, 0, .6); display: flex; flex-direction: column; }
  .bar { height: 40px; flex: none; display: flex; align-items: center; gap: 9px; padding: 0 14px 0 13px; background: #17181c; border-bottom: 1px solid #23252b; }
  .bar img { width: 20px; height: 20px; border-radius: 5px; }
  .bar .w { font-size: 13px; font-weight: 600; letter-spacing: .4px; }
  .bar .w .i { color: #8ab4f8; }
  .bar .a { font-size: 12px; color: #9aa0a6; margin-left: 4px; }
  .bar .u { margin-left: auto; font-size: 11px; line-height: 18px; padding: 0 8px; border-radius: 9px; background: rgba(138, 180, 248, .16); color: #a8c7fa; }
  .body { flex: 1; display: flex; min-height: 0; }
  .side { width: 56px; flex: none; background: #17181c; padding: 6px 0 14px; display: flex; flex-direction: column; align-items: center; gap: 9px; }
  .acct { position: relative; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-size: 17px; font-weight: 600;
    color: #fff; opacity: .82; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .14); }
  .acct.on { opacity: 1; box-shadow: 0 0 0 2px #17181c, 0 0 0 3.5px #8ab4f8; }
  .acct .l { display: block; transform: translate(3px, -3px); } /* clear of the badge in the lower left */
  .acct .provider { position: absolute; left: -1px; bottom: -1px; width: 17px; height: 17px; border-radius: 50%; border: 2px solid #17181c;
    background: #fff; display: grid; place-items: center; }
  .acct .provider svg { display: block; }
  .acct .provider.gmail { background: #ea4335; }
  .acct .provider.proton { background: #6d4aff; }
  .side .spacer { flex: 1; }
  .side .btn { width: 30px; height: 30px; border-radius: 50%; background: #26282e; color: #9aa0a6; display: grid; place-items: center; font-size: 17px; }
  .side .add { background: #26282e; color: #c4c7cc; }
  .side .pill { position: absolute; right: -4px; top: -5px; min-width: 17px; height: 16px; padding: 0 4px; border-radius: 8px; background: #ea4335;
    color: #fff; font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; box-shadow: 0 0 0 2px #17181c; }
  .mail { flex: 1; background: #f6f8fc; padding: 14px 18px; display: flex; flex-direction: column; gap: 6px; }
  .row { flex: 1; display: flex; align-items: center; gap: 12px; padding: 0 10px; border-radius: 10px; background: #fff;
    box-shadow: 0 1px 2px rgba(60, 64, 67, .12), 0 0 0 1px rgba(60, 64, 67, .06); }
  .row.unread { box-shadow: 0 1px 3px rgba(60, 64, 67, .2), 0 0 0 1px rgba(60, 64, 67, .12); }
  .ava { width: 22px; height: 22px; flex: none; border-radius: 50%; background: #dadce0; }
  .bars { flex: 1; display: flex; flex-direction: column; gap: 5px; }
  .bars i { display: block; height: 7px; border-radius: 4px; background: #e8eaed; }
  .bars i:first-child { height: 9px; background: #dadce0; }
  .unread .bars i:first-child { background: #bdc1c6; }
</style>
<div class="glow"></div>
<div class="canvas">
<div class="left">
  <div class="brand"><img class="logo" src="${logo}" alt=""><div class="word">MINIMA<span class="i">I</span>L</div></div>
  <p class="tag"><b>All your web mail</b>, in one light window.</p>
  <div class="chips">${chips}</div>
</div>
<div class="mock">
  <div class="bar"><img src="${logo}" alt=""><span class="w">MINIMA<span class="i">I</span>L</span><span class="a">alex@example.com</span><span class="u">15</span></div>
  <div class="body">
    <div class="side">
      ${accounts
        .map(
          ([initial, color, provider, on], i) =>
            `<div class="acct${on ? ' on' : ''}" style="background:${color}"><span class="l">${initial}</span>${i === 0 ? '<span class="pill">3</span>' : ''}<span class="provider ${provider}">${svg(marks[provider], 10)}</span></div>`,
        )
        .join('')}
      <div class="spacer"></div><div class="btn add">+</div><div class="btn">&#9881;</div>
    </div>
    <div class="mail">${rows}</div>
  </div>
</div>
</div>`;

app.whenReady().then(async () => {
  const out = path.join(__dirname, '..', 'docs', 'media', 'banner.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const win = new BrowserWindow({ width: 1320, height: 430, useContentSize: true, show: false, backgroundColor: '#141519' });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((resolve) => setTimeout(resolve, 700)); // fonts and the image
  // The canvas from the top-left corner, to the pixel. (A capture is "1x" as far
  // as Electron is concerned even at this scale factor, so this is in pixels.)
  const SCALE = 2;
  const image = (await win.webContents.capturePage()).crop({ x: 0, y: 0, width: 1272 * SCALE, height: 400 * SCALE });
  fs.writeFileSync(out, image.toPNG());
  console.log(`saved ${path.relative(process.cwd(), out)} (${image.getSize().width}x${image.getSize().height})`);
  app.exit(0);
});
