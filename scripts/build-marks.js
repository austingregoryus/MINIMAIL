'use strict';
// Builds src/marks.js from downloaded brand outline files.
//
//   node scripts/build-marks.js <folder-with-svg-files> <output-file>
//
// The SVG files are untrusted input: they are only ever read as text. A file
// contributes exactly one value — the "d" attribute of its first <path> — and
// only if the whole file is a plain <svg><title/><path/></svg> and the path
// consists of drawing commands alone. Anything else stops the build.
const fs = require('node:fs');
const path = require('node:path');

const [dir, outFile] = process.argv.slice(2);
if (!dir || !outFile) {
  console.error('usage: node scripts/build-marks.js <svg-folder> <output-file>');
  process.exit(2);
}

// provider id -> file name
const SOURCES = { gmail: 'gmail.svg', proton: 'protonmail.svg' };
const PATH_COMMANDS = /^[MmZzLlHhVvCcSsQqTtAaEe][MmZzLlHhVvCcSsQqTtAaEe0-9.,\s+-]*$/;
const PLAIN_SVG = /^<svg\s[^<>]*viewBox="0 0 24 24"[^<>]*>\s*<title>[^<>]*<\/title>\s*<path\s+(?:[^<>]*\s)?d="([^"]*)"\s*\/>\s*<\/svg>\s*$/;

const marks = {};
for (const [id, file] of Object.entries(SOURCES)) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  const m = PLAIN_SVG.exec(text);
  if (!m) {
    console.error(`${file}: not a plain single-path 24x24 SVG — stopping`);
    process.exit(1);
  }
  if (!PATH_COMMANDS.test(m[1])) {
    console.error(`${file}: the path contains something other than drawing commands — stopping`);
    process.exit(1);
  }
  marks[id] = m[1].trim();
  console.log(`${id.padEnd(8)} ${m[1].length} characters of outline`);
}

const body = `'use strict';
// Small provider marks for the badge on each account avatar. One outline per
// service, on a 24x24 grid, drawn in a single colour by the shell.
//
// The Gmail and Proton Mail outlines come from Simple Icons (simpleicons.org,
// released into the public domain). The names and logos belong to their
// owners and are used here only to label which service an account is on.
// The other adapters have no outline and get their initial instead.
module.exports = ${JSON.stringify(marks, null, 2)};
`;
fs.writeFileSync(outFile, body);
console.log('written:', outFile);
