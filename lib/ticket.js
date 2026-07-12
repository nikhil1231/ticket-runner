'use strict';

function richTextToPlain(rt) {
  return (rt || []).map((t) => t.plain_text ?? '').join('');
}

function blockToLines(block, indent) {
  const pad = '  '.repeat(indent);
  const data = block[block.type] || {};
  const text = richTextToPlain(data.rich_text);
  const lines = [];
  switch (block.type) {
    case 'heading_1': lines.push(`${pad}# ${text}`); break;
    case 'heading_2': lines.push(`${pad}## ${text}`); break;
    case 'heading_3': lines.push(`${pad}### ${text}`); break;
    case 'bulleted_list_item': lines.push(`${pad}- ${text}`); break;
    case 'numbered_list_item': lines.push(`${pad}1. ${text}`); break;
    case 'to_do': lines.push(`${pad}- [${data.checked ? 'x' : ' '}] ${text}`); break;
    case 'code': lines.push(`${pad}\`\`\`${data.language || ''}`, text, `${pad}\`\`\``); break;
    case 'quote':
    case 'callout': lines.push(`${pad}> ${text}`); break;
    case 'divider': lines.push(`${pad}---`); break;
    default: if (text) lines.push(`${pad}${text}`);
  }
  for (const child of block.children || []) {
    lines.push(...blockToLines(child, indent + 1));
  }
  return lines;
}

// Lossy plain-text/markdown flattening of a page body — good enough for a prompt.
function blocksToMarkdown(blocks) {
  const lines = [];
  for (const block of blocks) lines.push(...blockToLines(block, 0));
  return lines.join('\n').trim();
}

function prop(page, name) {
  return page.properties ? page.properties[name] : undefined;
}

function extractTicket(page) {
  const title = richTextToPlain(prop(page, 'Name')?.title) || '(untitled)';
  const cli = (prop(page, 'CLI')?.select?.name || '').toLowerCase();
  const attempts = prop(page, 'Attempts')?.number || 0;
  const kind = (prop(page, 'Kind')?.select?.name || '').toLowerCase() || undefined;
  return {
    pageId: page.id,
    // last chars of the UUID: the leading chars are near-identical across
    // pages created around the same time (prefix collision)
    shortId: page.id.replace(/-/g, '').slice(-12),
    url: page.url,
    createdTime: page.created_time,
    status: prop(page, 'Status')?.status?.name,
    title,
    kind,
    cli,
    attempts,
    // optional model pin for the implementer (empty = engine default); the
    // runner records the engine/model it actually used back into this field
    model: richTextToPlain(prop(page, 'Model')?.rich_text).trim(),
    reviewRounds: prop(page, 'Review rounds')?.number || 0,
    reviewFeedback: richTextToPlain(prop(page, 'Review feedback')?.rich_text).trim(),
    lastAgent: richTextToPlain(prop(page, 'Last agent')?.rich_text).trim(),
  };
}

module.exports = { blocksToMarkdown, extractTicket, richTextToPlain };
