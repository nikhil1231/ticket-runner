'use strict';

function richTextToPlain(rt) {
  return (rt || []).map((t) => t.plain_text ?? '').join('');
}

function prop(page, name) {
  return page.properties ? page.properties[name] : undefined;
}

function propertyTags(page) {
  const tags = [];
  for (const name of ['Tags', 'Tag']) {
    const value = prop(page, name);
    if (value?.multi_select) tags.push(...value.multi_select.map((option) => option.name));
    if (value?.select?.name) tags.push(value.select.name);
  }
  return Array.from(new Set(tags.filter(Boolean)));
}

function extractTicket(page) {
  const title = richTextToPlain(prop(page, 'Name')?.title) || '(untitled)';
  const cli = (prop(page, 'CLI')?.select?.name || '').toLowerCase();
  const attempts = prop(page, 'Attempts')?.number || 0;
  const kind = (prop(page, 'Kind')?.select?.name || '').toLowerCase() || undefined;
  const tags = propertyTags(page);
  return {
    pageId: page.id,
    shortId: page.id.replace(/-/g, '').slice(-12),
    url: page.url,
    createdTime: page.created_time,
    status: prop(page, 'Status')?.status?.name,
    title,
    kind,
    cli,
    attempts,
    model: richTextToPlain(prop(page, 'Model')?.rich_text).trim(),
    reviewRounds: prop(page, 'Review rounds')?.number || 0,
    reviewFeedback: richTextToPlain(prop(page, 'Review feedback')?.rich_text).trim(),
    lastAgent: richTextToPlain(prop(page, 'Last agent')?.rich_text).trim(),
    tags,
  };
}

module.exports = { extractTicket, richTextToPlain };
