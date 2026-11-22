import {TipTapDoc, TipTapNode} from '../types/noodle';

export interface PlainTextBlock {
  blockId: string;
  text: string;
}

export interface PlainTextExtraction {
  text: string;
  blocks: PlainTextBlock[];
}

function collectInlineText(nodes: TipTapNode[] | undefined): string {
  if (!Array.isArray(nodes)) {
    return '';
  }
  let out = '';
  for (const child of nodes) {
    if (child.type === 'text') {
      out += child.text ?? '';
    } else if (child.type === 'hardBreak') {
      out += '\n';
    } else if (Array.isArray(child.content)) {
      out += collectInlineText(child.content);
    }
  }
  return out;
}

function isLeafTextBlock(node: TipTapNode): boolean {
  if (
    node.type === 'paragraph' ||
    node.type === 'heading' ||
    node.type === 'codeBlock'
  ) {
    return true;
  }
  if (!Array.isArray(node.content) || node.content.length === 0) {
    return false;
  }
  return node.content.every(
    (c) => c.type === 'text' || c.type === 'hardBreak',
  );
}

/**
 * Pure function extracting plain text and an array of `{ blockId, text }`
 * in document order from TipTap JSON.
 */
export function extractPlainText(content: TipTapDoc): PlainTextExtraction {
  const blocks: PlainTextBlock[] = [];

  function walk(node: TipTapNode): void {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (isLeafTextBlock(node)) {
      const blockText = collectInlineText(node.content);
      if (blockText.trim().length > 0) {
        const blockId =
          node.attrs && typeof node.attrs.id === 'string' ? node.attrs.id : '';
        blocks.push({
          blockId,
          text: blockText,
        });
      }
      return;
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        walk(child);
      }
    }
  }

  if (content && Array.isArray(content.content)) {
    for (const child of content.content) {
      walk(child);
    }
  }

  return {
    text: blocks.map((b) => b.text).join('\n'),
    blocks,
  };
}
