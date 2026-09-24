/** Minimal typing of the pdfkit API used by the report PDF renderer (the package ships no types). */
declare module 'pdfkit' {
  interface PDFDocumentOptions {
    size?: string | [number, number];
    margins?: { top: number; bottom: number; left: number; right: number };
    bufferPages?: boolean;
    info?: Record<string, string>;
    autoFirstPage?: boolean;
  }
  interface TextOptions {
    width?: number;
    align?: 'left' | 'right' | 'center' | 'justify';
    lineBreak?: boolean;
    ellipsis?: boolean | string;
    height?: number;
    continued?: boolean;
  }
  class PDFDocument {
    constructor(options?: PDFDocumentOptions);
    page: { width: number; height: number; margins: { top: number; bottom: number; left: number; right: number } };
    x: number;
    y: number;
    font(src: string): this;
    fontSize(size: number): this;
    fillColor(color: string): this;
    strokeColor(color: string): this;
    lineWidth(w: number): this;
    text(text: string, x?: number | TextOptions, y?: number, options?: TextOptions): this;
    heightOfString(text: string, options?: TextOptions): number;
    moveDown(lines?: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    stroke(): this;
    addPage(): this;
    bufferedPageRange(): { start: number; count: number };
    switchToPage(n: number): this;
    on(event: 'data', cb: (chunk: Buffer) => void): this;
    on(event: 'end', cb: () => void): this;
    on(event: 'error', cb: (e: Error) => void): this;
    end(): void;
  }
  export default PDFDocument;
}
