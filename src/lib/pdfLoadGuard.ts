export const PDF_DOCUMENT_ATTEMPTS = 3;
export const PDF_PAGE_RENDER_ATTEMPTS = 3;
export const PDF_DOCUMENT_TIMEOUT_MS = 45_000;
export const PDF_PAGE_RENDER_TIMEOUT_MS = 15_000;

export class PdfTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} superó el tiempo máximo de ${Math.round(timeoutMs / 1000)} segundos.`);
    this.name = 'PdfTimeoutError';
  }
}

export function waitForRetry(attempt: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, Math.min(400 * 2 ** Math.max(attempt - 1, 0), 1600));
  });
}

export function withPdfTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      onTimeout?.();
      reject(new PdfTimeoutError(label, timeoutMs));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function isPdfCancellation(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  return name === 'RenderingCancelledException' || name === 'AbortException';
}
