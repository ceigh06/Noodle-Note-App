import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type {PDFDocumentProxy, PageViewport} from 'pdfjs-dist';
import {
  Check,
  Highlighter,
  Lock,
  MessageSquare,
  Minus,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  deletePdfAnnotation,
  listPdfAnnotationsByHash,
  savePdfAnnotation,
  updatePdfAnnotation,
} from '../db/noodleDb';
import {createUuid} from '../editor/noteSchema';
import {
  buildPdfCoordKey,
  computeBoundingBox,
  getHighlightStyle,
  normalizeSelectionRects,
  PDF_HIGHLIGHT_COLORS,
  sortPdfAnnotations,
} from '../pdf/pdfAnnotations';
import {
  computePdfBytesSha256,
  readSourceFileBytes,
} from '../storage/workspaceStorage';
import {
  PdfAnnotationRecord,
  PdfHighlightColor,
  PdfTextLayerAnchor,
  SourceDocumentEntry,
} from '../types/noodle';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface PdfSourceViewerProps {
  doc: SourceDocumentEntry;
  targetBlockId?: string | null;
}

interface PendingSelection {
  quote: string;
  anchor: PdfTextLayerAnchor;
  popoverTop: number;
  popoverLeft: number;
}

interface PageDimensions {
  pageNumber: number;
  baseWidth: number;
  baseHeight: number;
}

interface PdfPageCanvasProps {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  baseWidth: number;
  baseHeight: number;
  annotations: PdfAnnotationRecord[];
  activeAnnotationId: string | null;
  flashingAnnotationId: string | null;
  forceRender: boolean;
  onSelectAnnotation: (ann: PdfAnnotationRecord) => void;
  registerPageEl: (pageNumber: number, el: HTMLDivElement | null) => void;
}

function PdfPageCanvas({
  pdfDoc,
  pageNumber,
  scale,
  baseWidth,
  baseHeight,
  annotations,
  activeAnnotationId,
  flashingAnnotationId,
  forceRender,
  onSelectAnnotation,
  registerPageEl,
}: PdfPageCanvasProps) {
  const pageContainerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(pageNumber <= 2 || forceRender);
  const [renderedScale, setRenderedScale] = useState<number | null>(null);

  const width = Math.round(baseWidth * scale);
  const height = Math.round(baseHeight * scale);

  useEffect(() => {
    if (forceRender) {
      setIsVisible(true);
    }
  }, [forceRender]);

  useEffect(() => {
    const el = pageContainerRef.current;
    registerPageEl(pageNumber, el);
    return () => registerPageEl(pageNumber, null);
  }, [pageNumber, registerPageEl]);

  useEffect(() => {
    const el = pageContainerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setIsVisible(true);
          }
        }
      },
      {rootMargin: '600px 0px'},
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    let cancelled = false;
    let activeRenderTask: {cancel: () => void; promise: Promise<void>} | null =
      null;
    let activeTextLayer: {cancel: () => void; render: () => Promise<void>} | null =
      null;

    async function renderPage() {
      const page = await pdfDoc.getPage(pageNumber);
      if (cancelled) {
        return;
      }

      const viewport: PageViewport = page.getViewport({scale});
      const canvas = canvasRef.current;
      const textLayerEl = textLayerRef.current;
      if (!canvas || !textLayerEl) {
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }

      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
      const renderTask = page.render({
        canvas,
        viewport,
        ...(transform ? {transform} : {}),
      });
      activeRenderTask = renderTask;

      textLayerEl.replaceChildren();
      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textLayerEl,
        viewport,
      });
      activeTextLayer = textLayer;

      await Promise.all([renderTask.promise, textLayer.render()]);
      if (!cancelled) {
        setRenderedScale(scale);
      }
    }

    void renderPage().catch((err) => {
      if (
        !cancelled &&
        err &&
        (err as {name?: string}).name !== 'RenderingCancelledException' &&
        (err as {name?: string}).name !== 'AbortException'
      ) {
        console.warn(`PDF page ${pageNumber} render warning:`, err);
      }
    });

    return () => {
      cancelled = true;
      try {
        activeRenderTask?.cancel();
      } catch {
        // Ignore cancelled render task
      }
      try {
        activeTextLayer?.cancel();
      } catch {
        // Ignore cancelled text layer
      }
    };
  }, [isVisible, pageNumber, pdfDoc, scale]);

  const pageAnnotations = useMemo(
    () => annotations.filter((a) => a.anchor.pageNumber === pageNumber),
    [annotations, pageNumber],
  );

  return (
    <div
      ref={pageContainerRef}
      data-pdf-page={pageNumber}
      style={
        {
          width: `${width}px`,
          height: `${height}px`,
          '--total-scale-factor': String(scale),
        } as React.CSSProperties
      }
      className="noodle-pdf-page relative mx-auto shrink-0 overflow-hidden rounded-lg border border-[#2A2F3E] bg-white shadow-xl shadow-black/40"
    >
      <canvas ref={canvasRef} className="block bg-white" />

      {/* Highlight Rectangles Overlay (below textLayer so text stays cleanly selectable) */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[1]"
      >
        {pageAnnotations.map((ann) => {
          const style = getHighlightStyle(ann.color);
          const isActive = activeAnnotationId === ann.id;
          const isFlashing = flashingAnnotationId === ann.id;
          return ann.anchor.rects.map((rect, idx) => (
            <div
              key={`${ann.id}-r-${idx}`}
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.width * 100}%`,
                height: `${rect.height * 100}%`,
                backgroundColor: style.overlayBg,
                mixBlendMode: 'multiply',
                outline:
                  isActive || isFlashing
                    ? `2px solid ${style.overlayBorder}`
                    : 'none',
              }}
              className={`absolute rounded-[2px] transition-all duration-200 ${
                isFlashing ? 'noodle-pdf-highlight-flash' : ''
              }`}
            />
          ));
        })}
      </div>

      {/* PDF.js Interactive Text Layer */}
      <div ref={textLayerRef} className="textLayer" />

      {/* Margin Comment Indicator Pins */}
      {pageAnnotations.map((ann) => {
        if (!ann.comment.trim()) {
          return null;
        }
        const style = getHighlightStyle(ann.color);
        const isActive = activeAnnotationId === ann.id;
        return (
          <button
            key={`${ann.id}-pin`}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectAnnotation(ann);
            }}
            title={ann.comment}
            style={{
              top: `${Math.max(0.01, Math.min(0.95, ann.anchor.boundingBox.y)) * 100}%`,
              right: '6px',
            }}
            className={`absolute z-[3] flex h-5 w-5 items-center justify-center rounded-full border shadow-sm transition-transform hover:scale-110 ${
              isActive
                ? 'border-[#E0A83E] bg-[#141720] text-[#E0A83E]'
                : `border-[#2A2F3E] bg-[#141720]/90 text-[#ECEBE6] ${style.badgeBg}`
            }`}
          >
            <MessageSquare className="h-2.5 w-2.5" />
          </button>
        );
      })}

      {/* Page Number Watermark Pill */}
      <div className="pointer-events-none absolute right-2 bottom-2 z-[3] rounded bg-black/65 px-2 py-0.5 font-mono text-[10px] text-white/90 tabular-nums">
        Page {pageNumber}
        {renderedScale === null ? ' · loading…' : ''}
      </div>
    </div>
  );
}

function resolveSpanOffset(
  textLayerEl: HTMLElement,
  targetNode: Node,
  targetOffset: number,
): {spanIndex: number; charOffset: number} {
  const spans = Array.from(textLayerEl.querySelectorAll('span'));
  if (spans.length === 0) {
    return {spanIndex: 0, charOffset: 0};
  }

  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i];
    if (span === targetNode || span.contains(targetNode)) {
      let charOffset = targetOffset;
      if (targetNode.nodeType === Node.TEXT_NODE) {
        const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
        let priorChars = 0;
        let current = walker.nextNode();
        while (current) {
          if (current === targetNode) {
            charOffset = priorChars + targetOffset;
            break;
          }
          priorChars += current.textContent?.length ?? 0;
          current = walker.nextNode();
        }
      }
      return {spanIndex: i, charOffset};
    }
  }

  return {spanIndex: 0, charOffset: 0};
}

export function PdfSourceViewer({doc, targetBlockId = null}: PdfSourceViewerProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const viewerStageRef = useRef<HTMLDivElement | null>(null);
  const pageElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const pendingJumpRef = useRef<PdfAnnotationRecord | null>(null);

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageDims, setPageDims] = useState<PageDimensions[]>([]);
  const [verifiedHash, setVerifiedHash] = useState<string>(doc.contentHash);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scale, setScale] = useState<number>(1.2);
  const [currentPage, setCurrentPage] = useState<number>(1);

  const [annotations, setAnnotations] = useState<PdfAnnotationRecord[]>([]);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null,
  );
  const [flashingAnnotationId, setFlashingAnnotationId] = useState<
    string | null
  >(null);
  const [forcedPage, setForcedPage] = useState<number | null>(null);

  const [pendingSelection, setPendingSelection] =
    useState<PendingSelection | null>(null);
  const [selectedColor, setSelectedColor] =
    useState<PdfHighlightColor>('amber');
  const [commentDraft, setCommentDraft] = useState('');
  const [savingAnnotation, setSavingAnnotation] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingComment, setEditingComment] = useState('');
  const [editingColor, setEditingColor] =
    useState<PdfHighlightColor>('amber');

  const registerPageEl = useCallback(
    (pageNumber: number, el: HTMLDivElement | null) => {
      if (el) {
        pageElsRef.current.set(pageNumber, el);
      } else {
        pageElsRef.current.delete(pageNumber);
      }
    },
    [],
  );

  // Load PDF bytes read-only from sources/ (or demo fallback) and initialize pdf.js
  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;

    async function loadPdf() {
      setLoading(true);
      setLoadError(null);
      setPdfDoc(null);
      setPageDims([]);
      setPendingSelection(null);
      setActiveAnnotationId(null);
      setEditingId(null);

      try {
        const rawBytes = await readSourceFileBytes(doc.path, doc.contentHash);
        const hash = await computePdfBytesSha256(rawBytes);
        if (cancelled) {
          return;
        }
        setVerifiedHash(hash);

        const existingAnnotations = await listPdfAnnotationsByHash(hash);
        if (cancelled) {
          return;
        }
        setAnnotations(existingAnnotations);

        const dataCopy = new Uint8Array(rawBytes.slice(0));
        loadingTask = pdfjsLib.getDocument({
          data: dataCopy,
          useWorkerFetch: false,
        });
        const proxy = await loadingTask.promise;
        if (cancelled) {
          await loadingTask.destroy();
          return;
        }

        const dims: PageDimensions[] = [];
        for (let p = 1; p <= proxy.numPages; p += 1) {
          const page = await proxy.getPage(p);
          const vp = page.getViewport({scale: 1});
          dims.push({
            pageNumber: p,
            baseWidth: vp.width,
            baseHeight: vp.height,
          });
        }
        if (cancelled) {
          return;
        }

        setPageDims(dims);
        setPdfDoc(proxy);
        setCurrentPage(1);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            (err as Error).message || 'Could not load PDF document.',
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadPdf();

    return () => {
      cancelled = true;
      if (loadingTask) {
        void loadingTask.destroy().catch(() => {});
      }
    };
  }, [doc.contentHash, doc.path]);

  // Jump to page when navigated from Local Search or Synthesizer citation (e.g. "page-3-p-1")
  useEffect(() => {
    if (!targetBlockId || pageDims.length === 0) {
      return;
    }
    const match = /^page-(\d+)/i.exec(targetBlockId);
    if (!match) {
      return;
    }
    const targetPage = Number(match[1]);
    if (!Number.isFinite(targetPage) || targetPage < 1) {
      return;
    }
    setForcedPage(targetPage);
    const pageEl = pageElsRef.current.get(targetPage);
    const scrollEl = scrollContainerRef.current;
    if (pageEl && scrollEl) {
      scrollEl.scrollTo({
        top: Math.max(0, pageEl.offsetTop - 20),
        behavior: 'smooth',
      });
      setCurrentPage(targetPage);
    }
  }, [pageDims.length, targetBlockId]);

  const jumpToAnnotation = useCallback((ann: PdfAnnotationRecord) => {
    const scrollEl = scrollContainerRef.current;
    const pageEl = pageElsRef.current.get(ann.anchor.pageNumber);
    setForcedPage(ann.anchor.pageNumber);
    setActiveAnnotationId(ann.id);
    setFlashingAnnotationId(ann.id);

    if (scrollEl && pageEl) {
      const boxTopWithinPage = ann.anchor.boundingBox.y * pageEl.clientHeight;
      const absoluteTop = pageEl.offsetTop + boxTopWithinPage;
      const comfortOffset = Math.max(48, scrollEl.clientHeight * 0.28);
      scrollEl.scrollTo({
        top: Math.max(0, absoluteTop - comfortOffset),
        behavior: 'smooth',
      });
      setCurrentPage(ann.anchor.pageNumber);
    } else {
      pendingJumpRef.current = ann;
    }
  }, []);

  useEffect(() => {
    if (!flashingAnnotationId) {
      return;
    }
    const timer = window.setTimeout(() => {
      setFlashingAnnotationId(null);
    }, 2300);
    return () => window.clearTimeout(timer);
  }, [flashingAnnotationId]);

  useEffect(() => {
    if (pendingJumpRef.current && pageDims.length > 0) {
      const ann = pendingJumpRef.current;
      pendingJumpRef.current = null;
      jumpToAnnotation(ann);
    }
  }, [jumpToAnnotation, pageDims.length]);

  // Track current visible page on scroll
  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    if (!scrollEl || pageDims.length === 0) {
      return;
    }
    const onScroll = () => {
      const midY = scrollEl.scrollTop + scrollEl.clientHeight * 0.35;
      let closestPage = 1;
      for (const dim of pageDims) {
        const el = pageElsRef.current.get(dim.pageNumber);
        if (el && el.offsetTop <= midY) {
          closestPage = dim.pageNumber;
        }
      }
      setCurrentPage(closestPage);
    };
    scrollEl.addEventListener('scroll', onScroll, {passive: true});
    return () => scrollEl.removeEventListener('scroll', onScroll);
  }, [pageDims]);

  const handleFitWidth = useCallback(() => {
    const scrollEl = scrollContainerRef.current;
    const firstDim = pageDims[0];
    if (!scrollEl || !firstDim || firstDim.baseWidth <= 0) {
      return;
    }
    const available = Math.max(320, scrollEl.clientWidth - 48);
    const next = Math.max(0.5, Math.min(2.2, Number((available / firstDim.baseWidth).toFixed(2))));
    setScale(next);
  }, [pageDims]);

  // Capture text selection inside any page's PDF.js TextLayer
  const handleStageMouseUp = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }
    const quote = selection.toString().replace(/\s+/g, ' ').trim();
    if (!quote) {
      return;
    }

    const range = selection.getRangeAt(0);
    const startEl =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    const endEl =
      range.endContainer.nodeType === Node.ELEMENT_NODE
        ? (range.endContainer as Element)
        : range.endContainer.parentElement;

    const pageEl = startEl?.closest('[data-pdf-page]') as HTMLDivElement | null;
    const endPageEl = endEl?.closest('[data-pdf-page]') as HTMLDivElement | null;
    if (!pageEl || !endPageEl || pageEl !== endPageEl) {
      return;
    }

    const textLayerEl = pageEl.querySelector('.textLayer') as HTMLElement | null;
    if (!textLayerEl || !textLayerEl.contains(startEl)) {
      return;
    }

    const pageNumber = Number(pageEl.getAttribute('data-pdf-page'));
    if (!Number.isFinite(pageNumber) || pageNumber < 1) {
      return;
    }

    const pageRect = pageEl.getBoundingClientRect();
    const clientRects = Array.from(range.getClientRects()).map((r) => ({
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
    }));
    const rects = normalizeSelectionRects(clientRects, pageRect);
    if (rects.length === 0) {
      return;
    }

    const boundingBox = computeBoundingBox(rects);
    const startOffset = resolveSpanOffset(
      textLayerEl,
      range.startContainer,
      range.startOffset,
    );
    const endOffset = resolveSpanOffset(
      textLayerEl,
      range.endContainer,
      range.endOffset,
    );

    const anchor: PdfTextLayerAnchor = {
      pageNumber,
      startSpanIndex: startOffset.spanIndex,
      startCharOffset: startOffset.charOffset,
      endSpanIndex: endOffset.spanIndex,
      endCharOffset: endOffset.charOffset,
      rects,
      boundingBox,
    };

    const stageEl = viewerStageRef.current;
    const rangeRect = range.getBoundingClientRect();
    let popoverTop = 16;
    let popoverLeft = 24;
    if (stageEl) {
      const stageRect = stageEl.getBoundingClientRect();
      popoverTop = Math.max(
        12,
        Math.min(stageRect.height - 210, rangeRect.bottom - stageRect.top + 10),
      );
      popoverLeft = Math.max(
        12,
        Math.min(
          stageRect.width - 340,
          rangeRect.left - stageRect.left + rangeRect.width / 2 - 160,
        ),
      );
    }

    setPendingSelection({
      quote,
      anchor,
      popoverTop,
      popoverLeft,
    });
    setCommentDraft('');
  }, []);

  const handleSaveSelectionAnnotation = async () => {
    if (!pendingSelection || savingAnnotation) {
      return;
    }
    setSavingAnnotation(true);
    try {
      const now = new Date().toISOString();
      const record: PdfAnnotationRecord = {
        id: createUuid(),
        contentHash: verifiedHash,
        coordKey: buildPdfCoordKey(verifiedHash, pendingSelection.anchor),
        lastKnownPath: doc.path,
        docTitle: doc.title,
        quote: pendingSelection.quote,
        comment: commentDraft.trim(),
        color: selectedColor,
        anchor: pendingSelection.anchor,
        createdAt: now,
        updatedAt: now,
      };
      await savePdfAnnotation(record);
      setAnnotations((prev) => sortPdfAnnotations([...prev, record]));
      setActiveAnnotationId(record.id);
      setFlashingAnnotationId(record.id);
      setPendingSelection(null);
      setCommentDraft('');
      window.getSelection()?.removeAllRanges();
    } finally {
      setSavingAnnotation(false);
    }
  };

  const handleStartEdit = (ann: PdfAnnotationRecord) => {
    setEditingId(ann.id);
    setEditingComment(ann.comment);
    setEditingColor(ann.color);
  };

  const handleCommitEdit = async (id: string) => {
    const updated = await updatePdfAnnotation(id, {
      comment: editingComment.trim(),
      color: editingColor,
    });
    if (updated) {
      setAnnotations((prev) =>
        sortPdfAnnotations(prev.map((item) => (item.id === id ? updated : item))),
      );
    }
    setEditingId(null);
  };

  const handleDeleteAnnotation = async (id: string) => {
    await deletePdfAnnotation(id);
    setAnnotations((prev) => prev.filter((item) => item.id !== id));
    if (activeAnnotationId === id) {
      setActiveAnnotationId(null);
    }
    if (editingId === id) {
      setEditingId(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      {/* Left/Center: PDF.js Viewport */}
      <div
        ref={viewerStageRef}
        className="relative flex min-h-[60vh] min-w-0 flex-1 flex-col bg-[#0B0C0F]"
      >
        {/* PDF Viewer Controls Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1E222E] bg-[#101218] px-4 py-2 text-xs">
          <div className="flex items-center gap-2 text-[#9CA1AE]">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-[#272C3A] bg-[#151822] px-2 py-1 text-[11px] font-medium text-[#F3CA77]">
              <Highlighter className="h-3 w-3" />
              <span>Select text to highlight &amp; comment</span>
            </span>
            {pageDims.length > 0 && (
              <span className="font-mono text-[11px] text-[#8A91A2] tabular-nums">
                Page {currentPage} / {pageDims.length}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                setScale((s) => Math.max(0.6, Number((s - 0.15).toFixed(2))))
              }
              aria-label="Zoom out"
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-[#272C3A] bg-[#151822] text-[#C8CCD6] hover:border-[#3B4357] hover:text-white"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="w-12 text-center font-mono text-[11px] text-[#ECEBE6] tabular-nums">
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              onClick={() =>
                setScale((s) => Math.min(2.2, Number((s + 0.15).toFixed(2))))
              }
              aria-label="Zoom in"
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-[#272C3A] bg-[#151822] text-[#C8CCD6] hover:border-[#3B4357] hover:text-white"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleFitWidth}
              className="ml-1 inline-flex h-7 items-center rounded border border-[#272C3A] bg-[#151822] px-2.5 text-[11px] font-medium text-[#C8CCD6] hover:border-[#3B4357] hover:text-white"
            >
              Fit width
            </button>
          </div>
        </div>

        {/* Scrollable PDF Page Stack */}
        <div
          ref={scrollContainerRef}
          onMouseUp={handleStageMouseUp}
          className="relative flex-1 overflow-auto px-4 py-6 sm:px-6"
        >
          {loading ? (
            <div className="mx-auto max-w-xl rounded-xl border border-[#232734] bg-[#13161E] p-6 text-center text-xs text-[#9CA1AE]">
              Loading PDF via pdf.js (read-only)…
            </div>
          ) : loadError ? (
            <div className="mx-auto max-w-xl rounded-xl border border-rose-500/40 bg-rose-500/10 p-6 text-xs text-rose-200">
              {loadError}
            </div>
          ) : pdfDoc ? (
            <div className="flex flex-col items-center gap-6 pb-12">
              {pageDims.map((dim) => (
                <PdfPageCanvas
                  key={`${verifiedHash}-p${dim.pageNumber}`}
                  pdfDoc={pdfDoc}
                  pageNumber={dim.pageNumber}
                  scale={scale}
                  baseWidth={dim.baseWidth}
                  baseHeight={dim.baseHeight}
                  annotations={annotations}
                  activeAnnotationId={activeAnnotationId}
                  flashingAnnotationId={flashingAnnotationId}
                  forceRender={forcedPage === dim.pageNumber}
                  onSelectAnnotation={jumpToAnnotation}
                  registerPageEl={registerPageEl}
                />
              ))}
            </div>
          ) : null}
        </div>

        {/* Floating Selection Highlight & Comment Popover */}
        {pendingSelection && (
          <div
            style={{
              top: `${pendingSelection.popoverTop}px`,
              left: `${pendingSelection.popoverLeft}px`,
            }}
            className="absolute z-30 w-80 rounded-xl border border-[#343B4D] bg-[#141720] p-3.5 shadow-2xl shadow-black/70"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#F3CA77]">
                <Highlighter className="h-3.5 w-3.5" />
                <span>
                  Page {pendingSelection.anchor.pageNumber} Highlight
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  setPendingSelection(null);
                  window.getSelection()?.removeAllRanges();
                }}
                aria-label="Cancel highlight"
                className="rounded p-1 text-[#7D8496] hover:text-[#ECEBE6]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <p className="mt-1.5 line-clamp-2 rounded border border-[#232836] bg-[#0F1117] px-2.5 py-1.5 text-[11px] leading-relaxed text-[#D8D7D0] italic">
              &ldquo;{pendingSelection.quote}&rdquo;
            </p>

            {/* Color Swatches */}
            <div className="mt-2.5 flex items-center gap-2">
              <span className="text-[11px] text-[#8E95A5]">Color:</span>
              {PDF_HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedColor(c.id)}
                  aria-label={`Highlight ${c.label}`}
                  className={`h-5 w-5 rounded-full ${c.swatchClass} transition-transform ${
                    selectedColor === c.id
                      ? 'scale-110 ring-2 ring-white ring-offset-2 ring-offset-[#141720]'
                      : 'opacity-70 hover:opacity-100'
                  }`}
                />
              ))}
            </div>

            <textarea
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setPendingSelection(null);
                } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleSaveSelectionAnnotation();
                }
              }}
              rows={2}
              placeholder="Add a study comment (optional)…"
              className="mt-2.5 w-full resize-none rounded-lg border border-[#272C3A] bg-[#0E1015] px-2.5 py-2 text-xs text-[#ECEBE6] placeholder-[#686F80] focus:border-[#E0A83E]/60 focus:outline-none"
            />

            <div className="mt-2.5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setPendingSelection(null);
                  window.getSelection()?.removeAllRanges();
                }}
                className="rounded-lg border border-[#272C3A] bg-[#171A23] px-2.5 py-1.5 text-[11px] font-medium text-[#C8CCD6] hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSaveSelectionAnnotation()}
                disabled={savingAnnotation}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#E0A83E] px-3 py-1.5 text-[11px] font-semibold text-[#111216] hover:bg-[#ECB955] disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                <span>{savingAnnotation ? 'Saving…' : 'Save Annotation'}</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Persistent Right Pane: Annotations List */}
      <aside
        aria-label="PDF annotations list"
        className="flex w-full shrink-0 flex-col border-t border-[#232733] bg-[#101218] lg:w-88 lg:border-t-0 lg:border-l xl:w-96"
      >
        <div className="border-b border-[#202430] px-4 py-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Highlighter className="h-4 w-4 text-[#E0A83E]" />
              <h2 className="font-serif text-sm font-semibold text-[#F5F1E8]">
                Annotations
              </h2>
              <span className="rounded bg-[#191D28] px-1.5 py-0.5 font-mono text-[11px] text-[#D8D7D0] tabular-nums">
                {annotations.length}
              </span>
            </div>

            <span
              title={`Keyed by content hash ${verifiedHash}`}
              className="inline-flex items-center gap-1 font-mono text-[10px] text-[#888F9F]"
            >
              <Lock className="h-2.5 w-2.5 text-emerald-400" />
              <span>{verifiedHash.slice(0, 15)}…</span>
            </span>
          </div>

          <p className="mt-1 text-[11px] leading-relaxed text-[#7E8597]">
            Stored in IndexedDB by PDF content hash + text-layer coordinates.
            PDF bytes are never modified and annotations survive reloads &amp; file moves.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {annotations.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#262B38] bg-[#13161E]/60 p-4 text-xs leading-relaxed text-[#8E95A5]">
              No highlights or comments yet. Drag across any text in the PDF
              page to highlight and attach a note.
            </div>
          ) : (
            <div className="space-y-2.5">
              {annotations.map((ann) => {
                const style = getHighlightStyle(ann.color);
                const isActive = activeAnnotationId === ann.id;
                const isEditing = editingId === ann.id;
                const pctX = Math.round(ann.anchor.boundingBox.x * 100);
                const pctY = Math.round(ann.anchor.boundingBox.y * 100);

                return (
                  <div
                    key={ann.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => jumpToAnnotation(ann)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        jumpToAnnotation(ann);
                      }
                    }}
                    className={`group cursor-pointer rounded-xl border p-3 transition-colors ${
                      isActive
                        ? 'border-[#E0A83E]/65 bg-[#171B26]'
                        : 'border-[#212533] bg-[#13161E] hover:border-[#343B4F] hover:bg-[#161A24]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2.5 w-2.5 rounded-full ${style.swatchClass}`}
                        />
                        <span className="font-mono text-[11px] font-semibold text-[#ECEBE6] tabular-nums">
                          Page {ann.anchor.pageNumber}
                        </span>
                        <span className="font-mono text-[10px] text-[#767D8F] tabular-nums">
                          ({pctX}%, {pctY}%)
                        </span>
                      </div>

                      <div
                        className="flex items-center gap-1 opacity-80 group-hover:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => handleStartEdit(ann)}
                          aria-label="Edit annotation comment"
                          className="rounded p-1 text-[#888F9F] hover:bg-[#222736] hover:text-[#ECEBE6]"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteAnnotation(ann.id)}
                          aria-label="Delete annotation"
                          className="rounded p-1 text-[#888F9F] hover:bg-rose-500/15 hover:text-rose-300"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    <blockquote className="mt-2 border-l-2 border-[#363D52] pl-2.5 text-xs leading-relaxed text-[#D8D7D0] italic">
                      &ldquo;{ann.quote}&rdquo;
                    </blockquote>

                    {isEditing ? (
                      <div
                        className="mt-2.5 space-y-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center gap-1.5">
                          {PDF_HIGHLIGHT_COLORS.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => setEditingColor(c.id)}
                              aria-label={`Set color ${c.label}`}
                              className={`h-4 w-4 rounded-full ${c.swatchClass} ${
                                editingColor === c.id
                                  ? 'ring-2 ring-white ring-offset-1 ring-offset-[#13161E]'
                                  : 'opacity-65 hover:opacity-100'
                              }`}
                            />
                          ))}
                        </div>
                        <textarea
                          value={editingComment}
                          onChange={(e) => setEditingComment(e.target.value)}
                          rows={2}
                          placeholder="Write a comment…"
                          className="w-full resize-none rounded-lg border border-[#2B3040] bg-[#0D0F14] px-2.5 py-1.5 text-xs text-[#ECEBE6] focus:border-[#E0A83E]/60 focus:outline-none"
                        />
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="rounded border border-[#2B3040] px-2 py-1 text-[11px] text-[#9CA1AE] hover:text-white"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleCommitEdit(ann.id)}
                            className="rounded bg-[#E0A83E] px-2.5 py-1 text-[11px] font-semibold text-[#111216] hover:bg-[#ECB955]"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : ann.comment ? (
                      <p className="mt-2 rounded-lg bg-[#0E1016] px-2.5 py-2 text-xs leading-relaxed text-[#E6E4DC]">
                        {ann.comment}
                      </p>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartEdit(ann);
                        }}
                        className="mt-2 text-[11px] text-[#7D8496] hover:text-[#E0A83E]"
                      >
                        + Add comment
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
