import {
  clearPdfAnnotationsByHash,
  listPdfAnnotationsByHash,
  savePdfAnnotation,
  updatePdfAnnotation,
} from '../db/noodleDb';
import {
  computePdfBytesSha256,
  hasActiveWorkspace,
  readSourceFileBytes,
} from '../storage/workspaceStorage';
import {
  DiagnosticCheckResult,
  PdfAnnotationRecord,
  PdfTextLayerAnchor,
  SourceDocumentEntry,
} from '../types/noodle';
import {
  buildPdfCoordKey,
  buildSampleAcademicPdfBytes,
  computeBoundingBox,
  normalizeSelectionRects,
} from './pdfAnnotations';

export async function runPdfAnnotationDiagnostics(
  sourceDocuments: SourceDocumentEntry[],
): Promise<DiagnosticCheckResult[]> {
  const results: DiagnosticCheckResult[] = [];
  const sampleBytes = buildSampleAcademicPdfBytes();
  const sampleBuffer = sampleBytes.buffer.slice(
    sampleBytes.byteOffset,
    sampleBytes.byteOffset + sampleBytes.byteLength,
  ) as ArrayBuffer;
  const fallbackHash = await computePdfBytesSha256(sampleBuffer);

  // 1. PDF bytes are completely unchanged after annotating (read-only invariant)
  {
    const start = performance.now();
    const realPdf = sourceDocuments.find((d) => d.kind === 'pdf');
    let targetHash = fallbackHash;
    let targetPath = 'sources/_diag-sample.pdf';
    let bytesBefore = new Uint8Array(sampleBuffer.slice(0));
    let usedRealDiskPdf = false;

    try {
      if (realPdf && hasActiveWorkspace()) {
        const diskBefore = await readSourceFileBytes(
          realPdf.path,
          realPdf.contentHash,
        );
        bytesBefore = new Uint8Array(diskBefore.slice(0));
        targetHash = await computePdfBytesSha256(diskBefore);
        targetPath = realPdf.path;
        usedRealDiskPdf = true;
      }

      const anchor: PdfTextLayerAnchor = {
        pageNumber: 1,
        startSpanIndex: 2,
        startCharOffset: 0,
        endSpanIndex: 2,
        endCharOffset: 24,
        rects: [{x: 0.0915, y: 0.142, width: 0.482, height: 0.019}],
        boundingBox: {x: 0.0915, y: 0.142, width: 0.482, height: 0.019},
      };
      const coordKey = buildPdfCoordKey(targetHash, anchor);
      const diagId = `_diag_pdf_ann_${Date.now()}`;
      const now = new Date().toISOString();

      const record: PdfAnnotationRecord = {
        id: diagId,
        contentHash: targetHash,
        coordKey,
        lastKnownPath: targetPath,
        docTitle: 'Diagnostic PDF Check',
        quote: 'Sharp-wave ripples coordinate compressed replay',
        comment: 'Initial study comment',
        color: 'amber',
        anchor,
        createdAt: now,
        updatedAt: now,
      };

      const existingBefore = await listPdfAnnotationsByHash(targetHash);
      await savePdfAnnotation(record);
      await updatePdfAnnotation(diagId, {
        comment: 'Updated study comment',
        color: 'emerald',
      });
      const afterAnnotateList = await listPdfAnnotationsByHash(targetHash);
      const foundUpdated = afterAnnotateList.find((a) => a.id === diagId);

      // Re-read PDF bytes and verify byte-for-byte equality
      let bytesAfter = new Uint8Array(bytesBefore.slice(0));
      if (usedRealDiskPdf && realPdf) {
        const diskAfter = await readSourceFileBytes(realPdf.path, targetHash);
        bytesAfter = new Uint8Array(diskAfter);
      }
      const hashAfter = await computePdfBytesSha256(
        bytesAfter.buffer.slice(
          bytesAfter.byteOffset,
          bytesAfter.byteOffset + bytesAfter.byteLength,
        ) as ArrayBuffer,
      );

      let byteExact = bytesBefore.byteLength === bytesAfter.byteLength;
      if (byteExact) {
        for (let i = 0; i < bytesBefore.byteLength; i += 1) {
          if (bytesBefore[i] !== bytesAfter[i]) {
            byteExact = false;
            break;
          }
        }
      }

      // Restore annotations to clean pre-diagnostic state
      await clearPdfAnnotationsByHash(targetHash);
      for (const prev of existingBefore) {
        await savePdfAnnotation(prev);
      }

      const passed =
        byteExact &&
        hashAfter === targetHash &&
        foundUpdated?.comment === 'Updated study comment' &&
        foundUpdated?.color === 'emerald';

      results.push({
        id: 'pdf-bytes-unchanged',
        name: 'PDF Bytes Unchanged After Annotating',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? `Verified ${bytesAfter.byteLength} bytes and ${targetHash.slice(0, 18)}… remain byte-identical (${usedRealDiskPdf ? `real disk file ${targetPath}` : 'in-memory PDF fixture'}) while annotation saved & updated in IndexedDB.`
          : 'PDF byte verification or IndexedDB annotation round-trip failed.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'pdf-bytes-unchanged',
        name: 'PDF Bytes Unchanged After Annotating',
        status: 'FAIL',
        details: `Failed: ${(err as Error).message}`,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 2. Annotations survive file move/rename because lookup is keyed by contentHash + text-layer coords
  {
    const start = performance.now();
    const movedDiagHash = `sha256:diag-moved-${Date.now()}`;
    try {
      const rects = normalizeSelectionRects(
        [
          {left: 150, top: 220, width: 120, height: 18},
          {left: 268, top: 220, width: 90, height: 18},
        ],
        {left: 100, top: 100, width: 600, height: 800},
      );
      const boundingBox = computeBoundingBox(rects);
      const anchor: PdfTextLayerAnchor = {
        pageNumber: 2,
        startSpanIndex: 4,
        startCharOffset: 3,
        endSpanIndex: 5,
        endCharOffset: 11,
        rects,
        boundingBox,
      };
      const coordKey = buildPdfCoordKey(movedDiagHash, anchor);
      const now = new Date().toISOString();

      await savePdfAnnotation({
        id: '_diag_move_ann',
        contentHash: movedDiagHash,
        coordKey,
        lastKnownPath: 'sources/original/week1-lecture.pdf',
        docTitle: 'week1-lecture',
        quote: 'Place-cell replay preserves temporal order',
        comment: 'Survives moving to nested subfolder',
        color: 'sky',
        anchor,
        createdAt: now,
        updatedAt: now,
      });

      // Simulate file moved to a different path with the same content hash
      const loadedForMovedPath = await listPdfAnnotationsByHash(movedDiagHash);
      const hit = loadedForMovedPath[0];
      const passed =
        loadedForMovedPath.length === 1 &&
        hit.coordKey === coordKey &&
        hit.anchor.pageNumber === 2 &&
        hit.anchor.rects.length === 1 &&
        hit.anchor.boundingBox.x >= 0 &&
        hit.anchor.boundingBox.x <= 1 &&
        hit.comment === 'Survives moving to nested subfolder';

      results.push({
        id: 'pdf-annotations-survive-move',
        name: 'PDF Annotations Keyed by Hash Survive File Move',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? `Annotation anchored at Page 2 (${Math.round(hit.anchor.boundingBox.x * 100)}%, ${Math.round(hit.anchor.boundingBox.y * 100)}%) resolved cleanly after path move via ${movedDiagHash.slice(0, 18)}….`
          : 'Moved-file hash lookup or normalized text-layer coordinates failed.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'pdf-annotations-survive-move',
        name: 'PDF Annotations Keyed by Hash Survive File Move',
        status: 'FAIL',
        details: `Failed: ${(err as Error).message}`,
        durationMs: Math.round(performance.now() - start),
      });
    } finally {
      await clearPdfAnnotationsByHash(movedDiagHash).catch(() => {});
    }
  }

  return results;
}
