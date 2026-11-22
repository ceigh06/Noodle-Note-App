import {
  PdfAnnotationRecord,
  PdfHighlightColor,
  PdfNormalizedRect,
  PdfTextLayerAnchor,
} from '../types/noodle';

export const PDF_HIGHLIGHT_COLORS: Array<{
  id: PdfHighlightColor;
  label: string;
  swatchClass: string;
  overlayBg: string;
  overlayBorder: string;
  badgeBg: string;
}> = [
  {
    id: 'amber',
    label: 'Amber',
    swatchClass: 'bg-amber-400',
    overlayBg: 'rgba(224, 168, 62, 0.34)',
    overlayBorder: 'rgba(240, 194, 100, 0.85)',
    badgeBg: 'bg-amber-400/15 text-amber-200 border-amber-400/40',
  },
  {
    id: 'emerald',
    label: 'Emerald',
    swatchClass: 'bg-emerald-400',
    overlayBg: 'rgba(52, 211, 153, 0.3)',
    overlayBorder: 'rgba(110, 231, 183, 0.85)',
    badgeBg: 'bg-emerald-400/15 text-emerald-200 border-emerald-400/40',
  },
  {
    id: 'sky',
    label: 'Sky',
    swatchClass: 'bg-sky-400',
    overlayBg: 'rgba(56, 189, 248, 0.3)',
    overlayBorder: 'rgba(125, 211, 252, 0.85)',
    badgeBg: 'bg-sky-400/15 text-sky-200 border-sky-400/40',
  },
  {
    id: 'rose',
    label: 'Rose',
    swatchClass: 'bg-rose-400',
    overlayBg: 'rgba(251, 113, 133, 0.3)',
    overlayBorder: 'rgba(253, 164, 175, 0.85)',
    badgeBg: 'bg-rose-400/15 text-rose-200 border-rose-400/40',
  },
];

export function getHighlightStyle(color: PdfHighlightColor) {
  return (
    PDF_HIGHLIGHT_COLORS.find((item) => item.id === color) ??
    PDF_HIGHLIGHT_COLORS[0]
  );
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function normalizeSelectionRects(
  clientRects: ReadonlyArray<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>,
  pageRect: {left: number; top: number; width: number; height: number},
): PdfNormalizedRect[] {
  if (pageRect.width <= 0 || pageRect.height <= 0) {
    return [];
  }

  const raw: PdfNormalizedRect[] = [];
  for (const rect of clientRects) {
    if (rect.width < 1 || rect.height < 1) {
      continue;
    }
    const x1 = clamp01((rect.left - pageRect.left) / pageRect.width);
    const y1 = clamp01((rect.top - pageRect.top) / pageRect.height);
    const x2 = clamp01(
      (rect.left + rect.width - pageRect.left) / pageRect.width,
    );
    const y2 = clamp01(
      (rect.top + rect.height - pageRect.top) / pageRect.height,
    );
    const w = x2 - x1;
    const h = y2 - y1;
    if (w > 0.0005 && h > 0.0005) {
      raw.push({
        x: Number(x1.toFixed(5)),
        y: Number(y1.toFixed(5)),
        width: Number(w.toFixed(5)),
        height: Number(h.toFixed(5)),
      });
    }
  }

  if (raw.length <= 1) {
    return raw;
  }

  // Sort top-to-bottom, left-to-right and merge same-line adjacent/overlapping boxes
  raw.sort((a, b) => (Math.abs(a.y - b.y) > 0.006 ? a.y - b.y : a.x - b.x));

  const merged: PdfNormalizedRect[] = [];
  for (const next of raw) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({...next});
      continue;
    }

    const overlapY =
      Math.min(prev.y + prev.height, next.y + next.height) -
      Math.max(prev.y, next.y);
    const minH = Math.min(prev.height, next.height);
    const sameLine = minH > 0 && overlapY / minH >= 0.55;
    const horizontallyClose = next.x <= prev.x + prev.width + 0.012;

    if (sameLine && horizontallyClose) {
      const minX = Math.min(prev.x, next.x);
      const minY = Math.min(prev.y, next.y);
      const maxX = Math.max(prev.x + prev.width, next.x + next.width);
      const maxY = Math.max(prev.y + prev.height, next.y + next.height);
      prev.x = Number(minX.toFixed(5));
      prev.y = Number(minY.toFixed(5));
      prev.width = Number((maxX - minX).toFixed(5));
      prev.height = Number((maxY - minY).toFixed(5));
    } else {
      merged.push({...next});
    }
  }

  return merged;
}

export function computeBoundingBox(
  rects: ReadonlyArray<PdfNormalizedRect>,
): PdfNormalizedRect {
  if (rects.length === 0) {
    return {x: 0, y: 0, width: 0, height: 0};
  }
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const r of rects) {
    minX = Math.min(minX, clamp01(r.x));
    minY = Math.min(minY, clamp01(r.y));
    maxX = Math.max(maxX, clamp01(r.x + r.width));
    maxY = Math.max(maxY, clamp01(r.y + r.height));
  }
  return {
    x: Number(minX.toFixed(5)),
    y: Number(minY.toFixed(5)),
    width: Number(Math.max(0, maxX - minX).toFixed(5)),
    height: Number(Math.max(0, maxY - minY).toFixed(5)),
  };
}

/**
 * Deterministic key combining the PDF file's SHA-256 content hash plus
 * exact text-layer page, span offsets, and normalized bounding box.
 */
export function buildPdfCoordKey(
  contentHash: string,
  anchor: PdfTextLayerAnchor,
): string {
  const bb = anchor.boundingBox;
  return [
    contentHash.trim(),
    `p${anchor.pageNumber}`,
    `s${anchor.startSpanIndex}:${anchor.startCharOffset}-e${anchor.endSpanIndex}:${anchor.endCharOffset}`,
    `${bb.x.toFixed(4)},${bb.y.toFixed(4)},${bb.width.toFixed(4)},${bb.height.toFixed(4)}`,
  ].join('::');
}

export function sortPdfAnnotations(
  annotations: ReadonlyArray<PdfAnnotationRecord>,
): PdfAnnotationRecord[] {
  return [...annotations].sort((a, b) => {
    if (a.anchor.pageNumber !== b.anchor.pageNumber) {
      return a.anchor.pageNumber - b.anchor.pageNumber;
    }
    const dy = a.anchor.boundingBox.y - b.anchor.boundingBox.y;
    if (Math.abs(dy) > 0.005) {
      return dy;
    }
    const dx = a.anchor.boundingBox.x - b.anchor.boundingBox.x;
    if (Math.abs(dx) > 0.005) {
      return dx;
    }
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function escapePdfLiteral(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildTextPageStream(lines: Array<{text: string; size: number; y: number}>): string {
  const cmds: string[] = [];
  for (const line of lines) {
    cmds.push(
      `BT /F1 ${line.size} Tf 56 ${line.y} Td (${escapePdfLiteral(line.text)}) Tj ET`,
    );
  }
  return cmds.join('\n');
}

/**
 * Builds a valid, multi-page PDF 1.4 byte buffer with selectable Helvetica text.
 * Used for diagnostics and in-memory demo preview when no local disk folder is attached.
 */
export function buildSampleAcademicPdfBytes(): Uint8Array {
  const page1Stream = buildTextPageStream([
    {text: 'Buzsaki (2015) - Hippocampal Sharp-Wave Ripples', size: 16, y: 730},
    {text: 'Page 1: Two-Stage Memory Consolidation Architecture', size: 11, y: 700},
    {
      text: 'Sharp-wave ripples during slow-wave sleep coordinate compressed replay',
      size: 11,
      y: 668,
    },
    {
      text: 'of waking firing sequences across hippocampal and neocortical assemblies.',
      size: 11,
      y: 650,
    },
    {
      text: 'Disrupting post-learning ripples selectively impairs spatial consolidation',
      size: 11,
      y: 618,
    },
    {
      text: 'while leaving immediate trial acquisition completely intact.',
      size: 11,
      y: 600,
    },
    {
      text: 'High-frequency oscillations (140-220 Hz) synchronize CA3-CA1 ensembles',
      size: 11,
      y: 568,
    },
    {
      text: 'and transfer labile episodic traces into distributed cortical networks.',
      size: 11,
      y: 550,
    },
  ]);

  const page2Stream = buildTextPageStream([
    {text: 'Page 2: Experimental Predictions & Study Checklist', size: 14, y: 730},
    {
      text: '1. Closed-loop electrical suppression of ripples reduces retention scores.',
      size: 11,
      y: 694,
    },
    {
      text: '2. Place-cell replay preserves temporal order at 10x-20x compression.',
      size: 11,
      y: 672,
    },
    {
      text: '3. Source PDFs remain strictly immutable while annotations live in IndexedDB.',
      size: 11,
      y: 650,
    },
  ]);

  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `6 0 obj\n<< /Length ${page1Stream.length} >>\nstream\n${page1Stream}\nendstream\nendobj\n`,
    `7 0 obj\n<< /Length ${page2Stream.length} >>\nstream\n${page2Stream}\nendstream\nendobj\n`,
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}
