import {TipTapDoc, TipTapMark, TipTapNode} from '../types/noodle';
import {
  ensureBlockIds,
  isAllowedLinkUrl,
  isWorkspaceRelativeAssetPath,
} from './noteSchema';

/**
 * Strips raw HTML tags and dangerous tag blocks (<script>, <style>) cleanly.
 * Decodes basic HTML entities only where safe, without injecting DOM HTML.
 */
export function stripRawHtml(input: string): string {
  // Remove script/style/iframe blocks including contents
  let cleaned = input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Strip remaining HTML tags like <div>, <span>, <u>, <br>, <img>, etc.
  // Keep angle-bracket autolinks like <https://example.com> by turning them into plain URLs first
  cleaned = cleaned.replace(/<(https?:\/\/[^\s>]+)>/gi, '$1');
  cleaned = cleaned.replace(/<(mailto:[^\s>]+)>/gi, '$1');
  cleaned = cleaned.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  return cleaned;
}

// ---------- EXPORT: TipTap JSON -> Markdown (CommonMark + tables + task lists) ----------

function serializeMarks(text: string, marks?: TipTapMark[]): string {
  if (!marks || marks.length === 0) {
    return text;
  }

  const hasCode = marks.some((m) => m.type === 'code');
  let out = text;

  if (hasCode) {
    const tickRun = out.includes('`') ? '``' : '`';
    out =
      tickRun.length === 2
        ? `${tickRun} ${out} ${tickRun}`
        : `${tickRun}${out}${tickRun}`;
  }

  for (const mark of marks) {
    if (mark.type === 'code') {
      continue;
    }
    if (mark.type === 'bold') {
      out = `**${out}**`;
    } else if (mark.type === 'italic') {
      out = `*${out}*`;
    } else if (mark.type === 'strike') {
      out = `~~${out}~~`;
    } else if (mark.type === 'link') {
      const href =
        mark.attrs && typeof mark.attrs.href === 'string'
          ? mark.attrs.href
          : '';
      if (isAllowedLinkUrl(href)) {
        out = `[${out}](${href})`;
      }
    }
    // underline has no CommonMark syntax; text passes through cleanly (see docs/markdown-fidelity.md)
  }

  return out;
}

function serializeInline(nodes?: TipTapNode[]): string {
  if (!Array.isArray(nodes)) {
    return '';
  }
  return nodes
    .map((node) => {
      if (node.type === 'text') {
        return serializeMarks(node.text ?? '', node.marks);
      }
      if (node.type === 'hardBreak') {
        return '  \n';
      }
      if (Array.isArray(node.content)) {
        return serializeInline(node.content);
      }
      return '';
    })
    .join('');
}

function serializeListItem(
  item: TipTapNode,
  marker: string,
  indent: string,
): string {
  const children = item.content ?? [];
  const lines: string[] = [];

  children.forEach((child, idx) => {
    if (child.type === 'paragraph') {
      const text = serializeInline(child.content);
      if (idx === 0) {
        lines.push(`${indent}${marker}${text}`);
      } else {
        lines.push(`${indent}  ${text}`);
      }
    } else if (
      child.type === 'bulletList' ||
      child.type === 'orderedList' ||
      child.type === 'taskList'
    ) {
      lines.push(serializeList(child, `${indent}  `));
    } else {
      lines.push(`${indent}  ${serializeBlock(child)}`);
    }
  });

  if (lines.length === 0) {
    lines.push(`${indent}${marker}`);
  }

  return lines.join('\n');
}

function serializeList(node: TipTapNode, indent = ''): string {
  const items = node.content ?? [];
  const start =
    node.attrs && typeof node.attrs.start === 'number' ? node.attrs.start : 1;

  return items
    .map((item, idx) => {
      if (node.type === 'orderedList') {
        return serializeListItem(item, `${start + idx}. `, indent);
      }
      if (node.type === 'taskList') {
        const checked = Boolean(item.attrs?.checked);
        return serializeListItem(item, checked ? '- [x] ' : '- [ ] ', indent);
      }
      return serializeListItem(item, '- ', indent);
    })
    .join('\n');
}

function serializeTable(node: TipTapNode): string {
  const rows = (node.content ?? []).filter((r) => r.type === 'tableRow');
  if (rows.length === 0) {
    return '';
  }

  const rowCells = rows.map((row) =>
    (row.content ?? []).map((cell) => {
      const text = (cell.content ?? [])
        .map((block) => serializeInline(block.content))
        .join(' ')
        .replace(/\|/g, '\\|')
        .replace(/\n+/g, ' ')
        .trim();
      return text;
    }),
  );

  const colCount = Math.max(...rowCells.map((r) => r.length), 1);
  const padRow = (cells: string[]) => {
    const padded = [...cells];
    while (padded.length < colCount) {
      padded.push('');
    }
    return `| ${padded.join(' | ')} |`;
  };

  const headerLine = padRow(rowCells[0]);
  const separatorLine = `| ${Array(colCount).fill('---').join(' | ')} |`;
  const bodyLines = rowCells.slice(1).map(padRow);

  return [headerLine, separatorLine, ...bodyLines].join('\n');
}

function serializeBlock(node: TipTapNode): string {
  switch (node.type) {
    case 'heading': {
      const level = Math.min(
        Math.max(Number(node.attrs?.level ?? 1), 1),
        6,
      );
      return `${'#'.repeat(level)} ${serializeInline(node.content)}`;
    }
    case 'paragraph':
      return serializeInline(node.content);
    case 'blockquote': {
      const inner = (node.content ?? [])
        .map((child) => serializeBlock(child))
        .join('\n\n');
      return inner
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    }
    case 'codeBlock': {
      const lang =
        node.attrs && typeof node.attrs.language === 'string'
          ? node.attrs.language
          : '';
      const codeText = serializeInline(node.content);
      return `\`\`\`${lang}\n${codeText}\n\`\`\``;
    }
    case 'horizontalRule':
      return '---';
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return serializeList(node);
    case 'table':
      return serializeTable(node);
    case 'image': {
      const src =
        node.attrs && typeof node.attrs.src === 'string'
          ? node.attrs.src.trim()
          : '';
      if (!src || !isWorkspaceRelativeAssetPath(src)) {
        return '';
      }
      const rawAlt =
        node.attrs && typeof node.attrs.alt === 'string' ? node.attrs.alt : '';
      const alt = rawAlt.replace(/[\[\]\r\n]/g, ' ').trim();
      return `![${alt}](${src})`;
    }
    default:
      return serializeInline(node.content);
  }
}

export function tiptapToMarkdown(doc: TipTapDoc): string {
  const blocks = (doc.content ?? []).map(serializeBlock);
  return blocks.join('\n\n').trim();
}

// ---------- IMPORT: Markdown (CommonMark + tables + task lists) -> TipTap JSON ----------

function parseInlineMarkdown(rawText: string): TipTapNode[] {
  const nodes: TipTapNode[] = [];
  const text = stripRawHtml(rawText);

  const pushText = (value: string, marks?: TipTapMark[]) => {
    if (!value) {
      return;
    }
    nodes.push({
      type: 'text',
      text: value,
      ...(marks && marks.length > 0 ? {marks} : {}),
    });
  };

  // Tokenize inline code, links, bold, strike, italic left-to-right
  let i = 0;
  let plainBuffer = '';

  const flushPlain = () => {
    if (plainBuffer) {
      pushText(plainBuffer);
      plainBuffer = '';
    }
  };

  while (i < text.length) {
    // Escaped character
    if (text[i] === '\\' && i + 1 < text.length) {
      plainBuffer += text[i + 1];
      i += 2;
      continue;
    }

    // Inline code `...`
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        flushPlain();
        pushText(text.slice(i + 1, end), [{type: 'code'}]);
        i = end + 1;
        continue;
      }
    }

    // Link [label](url)
    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const label = text.slice(i + 1, closeBracket);
          const rawHref = text.slice(closeBracket + 2, closeParen).trim();
          flushPlain();
          if (isAllowedLinkUrl(rawHref)) {
            pushText(label, [{type: 'link', attrs: {href: rawHref}}]);
          } else {
            pushText(label);
          }
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Bold **...** or __...__
    if (
      (text.startsWith('**', i) || text.startsWith('__', i)) &&
      text.indexOf(text.slice(i, i + 2), i + 2) !== -1
    ) {
      const delim = text.slice(i, i + 2);
      const end = text.indexOf(delim, i + 2);
      if (end > i + 2) {
        flushPlain();
        const inner = parseInlineMarkdown(text.slice(i + 2, end));
        for (const child of inner) {
          pushText(child.text ?? '', [...(child.marks ?? []), {type: 'bold'}]);
        }
        i = end + 2;
        continue;
      }
    }

    // Strikethrough ~~...~~
    if (text.startsWith('~~', i)) {
      const end = text.indexOf('~~', i + 2);
      if (end > i + 2) {
        flushPlain();
        const inner = parseInlineMarkdown(text.slice(i + 2, end));
        for (const child of inner) {
          pushText(child.text ?? '', [...(child.marks ?? []), {type: 'strike'}]);
        }
        i = end + 2;
        continue;
      }
    }

    // Italic *...* or _..._
    if (text[i] === '*' || text[i] === '_') {
      const delim = text[i];
      const end = text.indexOf(delim, i + 1);
      if (end > i + 1 && text[i + 1] !== ' ') {
        flushPlain();
        const inner = parseInlineMarkdown(text.slice(i + 1, end));
        for (const child of inner) {
          pushText(child.text ?? '', [...(child.marks ?? []), {type: 'italic'}]);
        }
        i = end + 1;
        continue;
      }
    }

    plainBuffer += text[i];
    i += 1;
  }

  flushPlain();
  return nodes;
}

function makeParagraph(text: string): TipTapNode {
  const inline = parseInlineMarkdown(text);
  return {
    type: 'paragraph',
    ...(inline.length > 0 ? {content: inline} : {}),
  };
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (trimmed[i] === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += trimmed[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) {
    return false;
  }
  const cells = splitTableRow(trimmed);
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
  );
}

const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_RE = /^(\s*)\d+\.\s+(.*)$/;

function parseListBlock(
  lines: string[],
  startIndex: number,
  baseIndent: number,
): {node: TipTapNode; nextIndex: number} {
  const firstLine = lines[startIndex];
  const isTask = TASK_RE.test(firstLine);
  const isOrdered = !isTask && ORDERED_RE.test(firstLine);
  const listType = isTask
    ? 'taskList'
    : isOrdered
      ? 'orderedList'
      : 'bulletList';

  const items: TipTapNode[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      break;
    }
    const taskMatch = line.match(TASK_RE);
    const bulletMatch = !taskMatch ? line.match(BULLET_RE) : null;
    const orderedMatch = !taskMatch && !bulletMatch ? line.match(ORDERED_RE) : null;

    const match = taskMatch || bulletMatch || orderedMatch;
    if (!match) {
      break;
    }

    const indent = match[1].length;
    if (indent < baseIndent) {
      break;
    }
    if (indent > baseIndent) {
      // Attach nested list to previous item
      if (items.length > 0) {
        const nested = parseListBlock(lines, i, indent);
        items[items.length - 1].content = [
          ...(items[items.length - 1].content ?? []),
          nested.node,
        ];
        i = nested.nextIndex;
        continue;
      }
    }

    // If list type changes at same indent, stop this list
    const itemIsTask = Boolean(taskMatch);
    const itemIsOrdered = Boolean(orderedMatch);
    if (
      (listType === 'taskList' && !itemIsTask) ||
      (listType === 'orderedList' && !itemIsOrdered) ||
      (listType === 'bulletList' && (itemIsTask || itemIsOrdered))
    ) {
      break;
    }

    if (taskMatch) {
      const checked = taskMatch[2].toLowerCase() === 'x';
      items.push({
        type: 'taskItem',
        attrs: {checked},
        content: [makeParagraph(taskMatch[3])],
      });
    } else if (orderedMatch) {
      items.push({
        type: 'listItem',
        content: [makeParagraph(orderedMatch[2])],
      });
    } else if (bulletMatch) {
      items.push({
        type: 'listItem',
        content: [makeParagraph(bulletMatch[2])],
      });
    }

    i += 1;
  }

  return {
    node: {
      type: listType,
      ...(listType === 'orderedList' ? {attrs: {start: 1}} : {}),
      content: items,
    },
    nextIndex: i,
  };
}

export function markdownToTiptap(rawMarkdown: string): TipTapDoc {
  const sanitized = stripRawHtml(rawMarkdown).replace(/\r\n/g, '\n');
  const lines = sanitized.split('\n');
  const blocks: TipTapNode[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block ```
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && lines[i].trim().startsWith('```')) {
        i += 1;
      }
      const codeText = codeLines.join('\n');
      blocks.push({
        type: 'codeBlock',
        ...(lang ? {attrs: {language: lang}} : {}),
        ...(codeText ? {content: [{type: 'text', text: codeText}]} : {}),
      });
      continue;
    }

    // Heading #..######
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 3);
      blocks.push({
        type: 'heading',
        attrs: {level},
        content: parseInlineMarkdown(headingMatch[2]),
      });
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({type: 'horizontalRule'});
      i += 1;
      continue;
    }

    // Standalone image ![alt](assets/...)
    const imageMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (imageMatch) {
      const alt = imageMatch[1].trim();
      const rawSrc = imageMatch[2].trim();
      if (isWorkspaceRelativeAssetPath(rawSrc)) {
        blocks.push({
          type: 'image',
          attrs: {
            src: rawSrc,
            ...(alt ? {alt} : {}),
          },
        });
      }
      i += 1;
      continue;
    }

    // GFM Table
    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headerCells = splitTableRow(trimmed);
      const bodyRows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().includes('|')) {
        bodyRows.push(splitTableRow(lines[i]));
        i += 1;
      }

      const colCount = Math.max(
        headerCells.length,
        ...bodyRows.map((r) => r.length),
      );

      const buildRow = (cells: string[], isHeader: boolean): TipTapNode => {
        const rowCells: TipTapNode[] = [];
        for (let c = 0; c < colCount; c += 1) {
          rowCells.push({
            type: isHeader ? 'tableHeader' : 'tableCell',
            attrs: {colspan: 1, rowspan: 1, colwidth: null},
            content: [makeParagraph(cells[c] ?? '')],
          });
        }
        return {type: 'tableRow', content: rowCells};
      };

      blocks.push({
        type: 'table',
        content: [
          buildRow(headerCells, true),
          ...bodyRows.map((r) => buildRow(r, false)),
        ],
      });
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      const paragraphs = quoteLines
        .join('\n')
        .split(/\n{2,}/)
        .map((chunk) => makeParagraph(chunk.replace(/\n/g, ' ').trim()));
      blocks.push({
        type: 'blockquote',
        content: paragraphs,
      });
      continue;
    }

    // Lists (task / bullet / ordered)
    const listMatch =
      line.match(TASK_RE) || line.match(BULLET_RE) || line.match(ORDERED_RE);
    if (listMatch) {
      const parsed = parseListBlock(lines, i, listMatch[1].length);
      blocks.push(parsed.node);
      i = parsed.nextIndex;
      continue;
    }

    // Paragraph (consume consecutive non-special lines)
    const paraLines: string[] = [];
    while (i < lines.length) {
      const curr = lines[i];
      const currTrim = curr.trim();
      if (
        !currTrim ||
        currTrim.startsWith('```') ||
        /^(#{1,6})\s+/.test(currTrim) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(currTrim) ||
        /^!\[([^\]]*)\]\(([^)\s]+)\)$/.test(currTrim) ||
        currTrim.startsWith('>') ||
        TASK_RE.test(curr) ||
        BULLET_RE.test(curr) ||
        ORDERED_RE.test(curr) ||
        (currTrim.includes('|') &&
          i + 1 < lines.length &&
          isTableSeparator(lines[i + 1]))
      ) {
        break;
      }
      paraLines.push(currTrim);
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push(makeParagraph(paraLines.join(' ')));
    } else {
      i += 1;
    }
  }

  return ensureBlockIds({
    type: 'doc',
    content: blocks.length > 0 ? blocks : [makeParagraph('')],
  });
}
