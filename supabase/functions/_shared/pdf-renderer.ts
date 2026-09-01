const DEFAULT_PDFIUM_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.15.0/dist/pdfium.wasm";
const MAX_RENDER_DIMENSION = 1_600;
const MAX_RENDER_PAGES = 6;

type PdfiumModule = {
  pdfium: {
    HEAPU8: Uint8Array;
    wasmExports: { malloc(size: number): number; free(ptr: number): void };
  };
  PDFiumExt_Init(): unknown;
  FPDF_LoadMemDocument(ptr: number, size: number, password: string): number;
  FPDF_GetLastError(): number;
  FPDF_GetPageCount(doc: number): number;
  FPDF_LoadPage(doc: number, index: number): number;
  FPDF_ClosePage(page: number): unknown;
  FPDF_CloseDocument(doc: number): unknown;
  FPDF_GetPageWidthF(page: number): number;
  FPDF_GetPageHeightF(page: number): number;
  FPDFBitmap_CreateEx(
    width: number,
    height: number,
    format: number,
    buffer: number,
    stride: number,
  ): number;
  FPDFBitmap_Destroy(bitmap: number): unknown;
  FPDFBitmap_FillRect(
    bitmap: number,
    left: number,
    top: number,
    width: number,
    height: number,
    color: number,
  ): unknown;
  FPDF_RenderPageBitmap(
    bitmap: number,
    page: number,
    startX: number,
    startY: number,
    sizeX: number,
    sizeY: number,
    rotate: number,
    flags: number,
  ): unknown;
};

let pdfiumPromise: Promise<PdfiumModule> | undefined;

async function loadPdfium(): Promise<PdfiumModule> {
  const { init } = await import("npm:@embedpdf/pdfium@2.15.0");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const wasmUrl = Deno.env.get("PDFIUM_WASM_URL") || DEFAULT_PDFIUM_WASM_URL;
    const response = await fetch(wasmUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `Não foi possível carregar o renderizador PDF (HTTP ${response.status})`,
      );
    }
    const wasmBinary = await response.arrayBuffer();
    const module = await init({ wasmBinary });
    const pdfium = module as unknown as PdfiumModule;
    pdfium.PDFiumExt_Init();
    return pdfium;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("O renderizador PDF excedeu o tempo de inicialização");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getPdfium(): Promise<PdfiumModule> {
  pdfiumPromise ??= loadPdfium();
  try {
    return await pdfiumPromise;
  } catch (error) {
    pdfiumPromise = undefined;
    throw error;
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const payload = new Uint8Array(typeBytes.length + data.length);
  payload.set(typeBytes);
  payload.set(data, typeBytes.length);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(payload));
  return chunk;
}

async function encodePng(
  pixels: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const rowSize = width * 4;
  const scanlines = new Uint8Array((rowSize + 1) * height);
  for (let row = 0; row < height; row++) {
    const sourceStart = row * rowSize;
    const targetStart = row * (rowSize + 1);
    scanlines[targetStart] = 0;
    scanlines.set(
      pixels.subarray(sourceStart, sourceStart + rowSize),
      targetStart + 1,
    );
  }

  const compressedStream = new Blob([scanlines])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  const compressed = new Uint8Array(
    await new Response(compressedStream).arrayBuffer(),
  );

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const end = new Uint8Array(0);
  const chunks = [
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", end),
  ];
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function renderPdfPages(
  bytes: Uint8Array,
  requestedPages = MAX_RENDER_PAGES,
): Promise<{ images: Uint8Array[]; pageCount: number; renderedPages: number }> {
  const pdfium = await getPdfium();
  const memory = pdfium.pdfium.wasmExports;
  const filePtr = memory.malloc(bytes.byteLength);
  pdfium.pdfium.HEAPU8.set(bytes, filePtr);
  const document = pdfium.FPDF_LoadMemDocument(filePtr, bytes.byteLength, "");
  if (!document) {
    memory.free(filePtr);
    throw new Error(
      `PDF inválido ou protegido (código ${pdfium.FPDF_GetLastError()})`,
    );
  }

  try {
    const pageCount = pdfium.FPDF_GetPageCount(document);
    const pageLimit = Math.min(
      Math.max(1, Math.floor(requestedPages)),
      MAX_RENDER_PAGES,
      pageCount,
    );
    const images: Uint8Array[] = [];

    for (let index = 0; index < pageLimit; index++) {
      const page = pdfium.FPDF_LoadPage(document, index);
      if (!page) continue;
      try {
        const pageWidth = Math.max(
          1,
          Math.ceil(pdfium.FPDF_GetPageWidthF(page)),
        );
        const pageHeight = Math.max(
          1,
          Math.ceil(pdfium.FPDF_GetPageHeightF(page)),
        );
        const scale = Math.min(
          1.75,
          MAX_RENDER_DIMENSION / Math.max(pageWidth, pageHeight),
        );
        const width = Math.max(1, Math.round(pageWidth * scale));
        const height = Math.max(1, Math.round(pageHeight * scale));
        const stride = width * 4;
        const byteLength = stride * height;
        const bufferPtr = memory.malloc(byteLength);
        const bitmap = pdfium.FPDFBitmap_CreateEx(
          width,
          height,
          4,
          bufferPtr,
          stride,
        );
        if (!bitmap) {
          memory.free(bufferPtr);
          continue;
        }
        try {
          pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
          pdfium.FPDF_RenderPageBitmap(
            bitmap,
            page,
            0,
            0,
            width,
            height,
            0,
            16,
          );
          const pixels = pdfium.pdfium.HEAPU8.slice(
            bufferPtr,
            bufferPtr + byteLength,
          );
          images.push(await encodePng(pixels, width, height));
        } finally {
          pdfium.FPDFBitmap_Destroy(bitmap);
          memory.free(bufferPtr);
        }
      } finally {
        pdfium.FPDF_ClosePage(page);
      }
    }

    if (!images.length) {
      throw new Error("Não foi possível renderizar nenhuma página do PDF");
    }
    return { images, pageCount, renderedPages: images.length };
  } finally {
    pdfium.FPDF_CloseDocument(document);
    memory.free(filePtr);
  }
}
