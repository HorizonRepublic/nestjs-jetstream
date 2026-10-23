/* Builds a social preview image for every docs page: its title, the sidebar
   section it belongs to in that section's tone, and the package name.

   Output goes to static/img/og/<doc id>.png, which is git-ignored; the build
   runs this first. Text is laid out here, then rasterised by resvg. */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import sidebars from '../../sidebars.ts';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..', '..');
const docsDir = join(site, 'docs');
const outDir = join(site, 'static', 'img', 'og');
const fonts = [join(here, 'Inter-Medium.ttf'), join(here, 'Inter-Bold.ttf')];

const W = 1200;
const H = 630;

// the same tones the site uses, dark theme values
const TONES = {
  Start: '#86aaf2',
  'Delivery patterns': '#86aaf2',
  'Messages and handlers': '#b9a6f2',
  Scheduling: '#e2a84b',
  Reliability: '#5fcf95',
  Infrastructure: '#5cc6d2',
  Observability: '#f08bb4',
  Troubleshooting: '#ee8a76',
};
const NEUTRAL = '#8f97a8';

/* doc id -> top-level sidebar section label */
const sections = new Map();
const walk = (items, section) => {
  for (const item of items) {
    if (typeof item === 'string') sections.set(item, section);
    else if (item.type === 'category') {
      if (item.link?.type === 'doc') sections.set(item.link.id, section ?? item.label);
      walk(item.items ?? [], section ?? item.label);
    }
  }
};

walk(sidebars.docsSidebar, null);

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) return name === 'api' ? [] : files(path);

    return /\.mdx?$/.test(name) ? [path] : [];
  });

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Greedy wrap by an average glyph width; good enough for a headline in Inter Bold. */
const wrap = (text, size, width, maxLines) => {
  const perLine = Math.floor(width / (size * 0.56));
  const lines = [];
  let line = '';

  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > perLine && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }

  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\s+\S*$/, '')}…`;
  }

  return lines;
};

const titleOf = (source) => source.match(/^#\s+(.+)$/m)?.[1].replace(/`/g, '').trim();

const card = ({ title, section, tone }) => {
  const size = title.length > 48 ? 58 : 66;
  const lines = wrap(title, size, 980, 3);
  const top = 300 - ((lines.length - 1) * size * 1.12) / 2;
  const titleText = lines
    .map((line, i) => `<text x="96" y="${top + i * size * 1.12}" font-family="Inter" font-weight="700" font-size="${size}" fill="#eef1f8" letter-spacing="-1.5">${escape(line)}</text>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="0.86" cy="0.12" r="0.75">
      <stop offset="0" stop-color="${tone}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${tone}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0H0V40" fill="none" stroke="#2f3542" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="#171a21"/>
  <rect width="${W}" height="${H}" fill="url(#grid)" opacity="0.45"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="96" y="112" width="44" height="6" rx="3" fill="${tone}"/>
  <text x="96" y="168" font-family="Inter" font-weight="500" font-size="30" fill="${tone}">${escape(section)}</text>
  ${titleText}
  <text x="96" y="548" font-family="Inter" font-weight="500" font-size="26" fill="#8f97a8">@horizon-republic/nestjs-jetstream</text>
  <text x="${W - 96}" y="548" text-anchor="end" font-family="Inter" font-weight="500" font-size="26" fill="#5b6475">NestJS · NATS JetStream</text>
</svg>`;
};

let count = 0;

for (const path of files(docsDir)) {
  const id = relative(docsDir, path).replace(/\.mdx?$/, '');
  const source = readFileSync(path, 'utf8');
  const title = titleOf(source);

  if (!title) continue;

  const section = sections.get(id) ?? 'Documentation';
  const svg = card({ title, section, tone: TONES[section] ?? NEUTRAL });
  const png = new Resvg(svg, { font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
  const out = join(outDir, `${id}.png`);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  count += 1;
}

console.log(`og: ${count} images in ${relative(site, outDir)}`);
