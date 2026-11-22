import * as pdfjsLib from 'pdfjs-dist';

interface WorkerScope {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<PdfExtractRequest>) => void,
  ) => void;
}

interface PdfExtractRequest {
  id: string;
  buffer: ArrayBuffer;
}

const ctx = globalThis as unknown as WorkerScope;

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

ctx.addEventListener('message', async (event) => {
  const {id, buffer} = event.data;
  try {
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      disableFontFace: true,
    });
    const pdfDoc = await loadingTask.promise;
    const pages: Array<{pageNumber: number; text: string}> = [];

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum += 1) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      let pageText = '';
      let lastY: number | null = null;

      for (const rawItem of textContent.items) {
        if (!('str' in rawItem) || typeof rawItem.str !== 'string') {
          continue;
        }
        const y = Array.isArray(rawItem.transform)
          ? Number(rawItem.transform[5])
          : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 14) {
          pageText += '\n\n';
        } else if (lastY !== null && y !== null && Math.abs(y - lastY) > 3) {
          pageText += '\n';
        } else if (pageText && !pageText.endsWith(' ') && !pageText.endsWith('\n')) {
          pageText += ' ';
        }
        pageText += rawItem.str;
        if ('hasEOL' in rawItem && rawItem.hasEOL) {
          pageText += '\n';
        }
        if (y !== null) {
          lastY = y;
        }
      }

      const cleaned = pageText.replace(/[ \t]+\n/g, '\n').trim();
      if (cleaned) {
        pages.push({pageNumber: pageNum, text: cleaned});
      }
      page.cleanup();
    }

    await loadingTask.destroy();
    ctx.postMessage({id, ok: true, pages});
  } catch (err) {
    ctx.postMessage({
      id,
      ok: false,
      error: (err as Error).message || 'Failed to parse PDF document.',
    });
  }
});
