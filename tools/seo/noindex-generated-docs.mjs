/**
 * Marks the generated API reference as `noindex`.
 *
 * The pages carry scraped headings as their meta description ("Defined in91"),
 * which reads as thin content to a crawler and drags the whole site down. They
 * stay in the sidebar and in local search, where they are useful; they leave the
 * search index only. The Docusaurus sitemap plugin drops any page carrying the
 * tag, so this shrinks sitemap.xml as a side effect.
 *
 * Runs after every TypeDoc generation, so new symbols pick it up on their own.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = 'website/docs/reference/api';
const TAG = '<head>\n  <meta name="robots" content="noindex" />\n</head>\n\n';

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

const files = await collect(ROOT);
let marked = 0;

for (const file of files) {
  const content = await readFile(file, 'utf8');

  if (content.includes('content="noindex"')) {
    continue;
  }

  await writeFile(file, TAG + content);
  marked += 1;
}

console.log(`noindex applied to ${marked} of ${files.length} generated pages`);
