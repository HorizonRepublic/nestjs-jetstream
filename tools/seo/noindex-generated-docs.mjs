/**
 * Adds front matter and a `noindex` tag to the generated API reference.
 *
 * TypeDoc writes no front matter, so Docusaurus falls back to scraping the page
 * for a description and picks up "Defined in91". That reads as thin content to a
 * crawler and drags the whole site down, and it is what `llms.txt` publishes as
 * the page summary. The title and the first paragraph of the doc comment give
 * both a real value.
 *
 * The pages stay in the sidebar and in local search, where they are useful, and
 * leave the search index only. The Docusaurus sitemap plugin drops any page
 * carrying the robots tag, so this shrinks sitemap.xml as a side effect.
 *
 * Runs after every TypeDoc generation, so new symbols pick it up on their own.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = 'website/docs/reference/api';
const ROBOTS = '<head>\n  <meta name="robots" content="noindex" />\n</head>';

/** Every markdown file under the generated reference, recursively. */
const collect = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collect(path)));
    } else if (entry.name.endsWith('.md')) {
      files.push(path);
    }
  }

  return files;
};

/** The `# Symbol` heading TypeDoc writes for every page. */
const readTitle = (content) => content.match(/^# (.+)$/m)?.[1]?.trim() ?? null;

/**
 * First prose paragraph of the doc comment. TypeDoc puts a `Defined in:` source
 * link before it, and markdown constructs after it, so anything that opens with
 * a link, heading, table or fence is skipped.
 */
const readSummary = (content) => {
  const body = content.split(/^Defined in:.*$/m)[1];

  if (body === undefined) {
    return null;
  }

  for (const block of body.split('\n\n')) {
    const text = block.trim();

    if (text === '' || /^[#>|*\-`[]/.test(text) || text.startsWith('***')) {
      continue;
    }

    return text.replace(/\s+/g, ' ').replace(/`/g, '');
  }

  return null;
};

/** Escapes a value for a double-quoted YAML scalar. */
const quote = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const truncate = (text, limit) =>
  text.length <= limit ? text : `${text.slice(0, text.lastIndexOf(' ', limit))}…`;

const files = await collect(ROOT);
let marked = 0;
let described = 0;

for (const file of files) {
  const content = await readFile(file, 'utf8');

  if (content.startsWith('---')) {
    continue;
  }

  const title = readTitle(content);
  const summary = readSummary(content);
  const fields = ['---'];

  if (title !== null) {
    fields.push(`title: ${quote(title)}`);
  }

  // A symbol with no doc comment still needs a description: without one the
  // llms.txt plugin falls back to the first line of the body, which is the
  // robots tag below.
  const description = summary ?? (title === null ? null : `${title} in the API reference.`);

  if (description !== null) {
    fields.push(`description: ${quote(truncate(description, 155))}`);
    described += 1;
  }

  fields.push('---', '', ROBOTS, '', '');

  await writeFile(file, fields.join('\n') + content);
  marked += 1;
}

console.log(`api reference: ${marked} pages marked noindex, ${described} given a description`);
