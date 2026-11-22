export interface ExtractedPdfPage {
  pageNumber: number;
  text: string;
}

interface PdfWorkerResponse {
  id: string;
  ok: boolean;
  pages?: ExtractedPdfPage[];
  error?: string;
}

let pdfWorkerInstance: Worker | null = null;
let requestCounter = 0;

const pendingRequests = new Map<
  string,
  {
    resolve: (pages: ExtractedPdfPage[]) => void;
    reject: (err: Error) => void;
  }
>();

function getPdfWorker(): Worker {
  if (!pdfWorkerInstance) {
    pdfWorkerInstance = new Worker(
      new URL('./pdfWorker.ts', import.meta.url),
      {type: 'module'},
    );
    pdfWorkerInstance.onmessage = (event: MessageEvent<PdfWorkerResponse>) => {
      const {id, ok, pages, error} = event.data;
      const pending = pendingRequests.get(id);
      if (!pending) {
        return;
      }
      pendingRequests.delete(id);
      if (ok && pages) {
        pending.resolve(pages);
      } else {
        pending.reject(new Error(error || 'PDF extraction worker failed.'));
      }
    };
    pdfWorkerInstance.onerror = (event) => {
      const message = event.message || 'PDF worker crashed.';
      for (const [, pending] of pendingRequests.entries()) {
        pending.reject(new Error(message));
      }
      pendingRequests.clear();
      pdfWorkerInstance?.terminate();
      pdfWorkerInstance = null;
    };
  }
  return pdfWorkerInstance;
}

/**
 * Extracts text per page from raw PDF bytes strictly inside a Web Worker.
 */
export function extractPdfPagesInWorker(
  buffer: ArrayBuffer,
): Promise<ExtractedPdfPage[]> {
  if (typeof Worker === 'undefined') {
    return Promise.reject(
      new Error('Web Workers are unavailable for PDF text extraction.'),
    );
  }
  const worker = getPdfWorker();
  const id = `pdf-${Date.now()}-${++requestCounter}`;
  // Copy slice so caller's buffer (used for SHA-256 hashing) is never detached
  const transferableCopy = buffer.slice(0);

  return new Promise<ExtractedPdfPage[]>((resolve, reject) => {
    pendingRequests.set(id, {resolve, reject});
    worker.postMessage({id, buffer: transferableCopy}, [transferableCopy]);
  });
}
