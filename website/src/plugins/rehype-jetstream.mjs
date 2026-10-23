/**
 * Rehype plugin for the docs:
 * - turns the "> **Use when:** … **You get:** …" opener into a labelled lede block;
 * - tags inline code that names a settlement (`ack`, `nak`, `term`, `ctx.retry()`, …)
 *   with its message state, so the stylesheet can colour it.
 */

const STATE_BY_CODE = [
  [/^(msg\.)?ack(\(\))?$/, 'ack'],
  [/^(msg\.)?nak(\([^)]*\))?$/, 'redeliver'],
  [/^ctx\.retry\(\)$/, 'redeliver'],
  [/^(msg\.)?term(\(\))?$/, 'dlq'],
  [/^ctx\.terminate\(\)$/, 'dlq'],
];

const LEDE_LABELS = ['Use when:', 'You get:'];

const textOf = (node) =>
  node.type === 'text' ? node.value : (node.children ?? []).map(textOf).join('');

const isLabel = (node, label) =>
  node.type === 'element' && node.tagName === 'strong' && textOf(node).trim() === label;

const trimEdges = (nodes) => {
  const out = [...nodes];

  while (out[0]?.type === 'text' && !out[0].value.trim()) out.shift();
  while (out.at(-1)?.type === 'text' && !out.at(-1).value.trim()) out.pop();

  if (out[0]?.type === 'text') out[0] = { ...out[0], value: out[0].value.trimStart() };

  return out;
};

const toLede = (blockquote) => {
  const paragraph = blockquote.children.find((child) => child.type === 'element');

  if (paragraph?.tagName !== 'p') return null;

  const first = paragraph.children.find((child) => child.type !== 'text' || child.value.trim());

  if (!first || !isLabel(first, LEDE_LABELS[0])) return null;

  const rows = [];

  for (const child of paragraph.children) {
    const label = LEDE_LABELS.find((candidate) => isLabel(child, candidate));

    if (label) {
      rows.push({ label, content: [] });
    } else if (rows.length && !(child.type === 'element' && child.tagName === 'br')) {
      rows.at(-1).content.push(child);
    }
  }

  return {
    type: 'element',
    tagName: 'div',
    properties: { className: ['jt-lede'] },
    children: rows.map((row, index) => ({
      type: 'element',
      tagName: 'p',
      properties: { className: ['jt-lede-row'], dataRole: index === 0 ? 'when' : 'get' },
      children: [
        {
          type: 'element',
          tagName: 'span',
          properties: { className: ['jt-lede-label'] },
          children: [{ type: 'text', value: row.label.replace(':', '') }],
        },
        {
          type: 'element',
          tagName: 'span',
          properties: { className: ['jt-lede-text'] },
          children: trimEdges(row.content),
        },
      ],
    })),
  };
};

const walk = (node, inPre) => {
  if (!node.children) return;

  node.children = node.children.map((child) => {
    if (child.type !== 'element') return child;

    if (child.tagName === 'blockquote') {
      const lede = toLede(child);

      if (lede) return lede;
    }

    if (child.tagName === 'code' && !inPre) {
      const text = textOf(child).trim();
      const match = STATE_BY_CODE.find(([pattern]) => pattern.test(text));

      if (match) {
        child.properties = { ...child.properties, dataState: match[1] };
      }
    }

    walk(child, inPre || child.tagName === 'pre');

    return child;
  });
};

export default function rehypeJetstream() {
  return (tree) => walk(tree, false);
}
