import { PDFAssembler } from 'pdfassembler';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.js?url';

GlobalWorkerOptions.workerSrc = workerSrc;

export interface ReplacementContext {
  bbox?: [number, number, number, number];
  transform?: number[];
  fontSize?: number;
}

type PdfStructure = Record<string, any>;

let assembler: PDFAssembler | null = null;
let pdfDocument: PDFDocumentProxy | null = null;
let pdfStructure: PdfStructure | null = null;
let sourceBuffer: ArrayBuffer | null = null;

export async function createAssembler(buffer: ArrayBuffer): Promise<void> {
  assembler = new PDFAssembler(buffer);
  sourceBuffer = buffer;
  pdfDocument = await getDocument({ data: buffer }).promise;
  pdfStructure = await assembler.getPDFStructure();
}

export function getPDFDocument(): PDFDocumentProxy {
  if (!pdfDocument) {
    throw new Error('PDF document not initialized');
  }
  return pdfDocument;
}

export function getPDFStructure(): PdfStructure {
  if (!pdfStructure) {
    throw new Error('PDF structure not ready');
  }
  return pdfStructure;
}

export function getAssembler(): PDFAssembler {
  if (!assembler) {
    throw new Error('PDF assembler not initialized');
  }
  return assembler;
}

export async function countPages(): Promise<number> {
  if (!assembler) {
    throw new Error('PDF assembler not initialized');
  }
  return assembler.countPages();
}

export type ReplacementResult = 'replaced' | 'fallback' | 'skipped';

export async function replaceTextOnPage(
  pageIndex: number,
  before: string,
  after: string,
  context?: ReplacementContext
): Promise<ReplacementResult> {
  if (!assembler || !pdfStructure) {
    throw new Error('PDF assembler not initialized');
  }
  const pages = pdfStructure['/Root']['/Pages']['/Kids'];
  const page = pages[pageIndex];
  if (!page) {
    throw new Error(`Page ${pageIndex + 1} not found in structure`);
  }
  const contents = Array.isArray(page['/Contents']) ? page['/Contents'] : [page['/Contents']].filter(Boolean);
  if (!contents.length) {
    return 'skipped';
  }
  const sanitizedBefore = before ?? '';
  const sanitizedAfter = after ?? '';
  if (!sanitizedBefore.length) {
    return 'skipped';
  }
  let replaced = false;
  let fallbackApplied = false;
  const updatedContents = contents.map((content: any) => {
    if (!content || typeof content.stream !== 'string') {
      return content;
    }
    const { stream, replaced: streamReplaced } = replaceInContentStream(
      content.stream,
      sanitizedBefore,
      sanitizedAfter
    );
    if (streamReplaced) {
      replaced = true;
      return { ...content, stream };
    }
    return content;
  });

  if (!replaced && context) {
    const fallbackStream = buildFallbackStream(page, sanitizedAfter, context);
    if (fallbackStream) {
      fallbackApplied = true;
      const target = Array.isArray(page['/Contents']) ? page['/Contents'] : [page['/Contents']].filter(Boolean);
      target.push(fallbackStream);
      page['/Contents'] = target;
    }
  } else {
    page['/Contents'] = Array.isArray(page['/Contents']) ? updatedContents : updatedContents[0];
  }

  if (replaced) {
    return 'replaced';
  }
  if (fallbackApplied) {
    return 'fallback';
  }
  return 'skipped';
}

function replaceInContentStream(stream: string, before: string, after: string): { stream: string; replaced: boolean } {
  let buffer = stream;
  let replaced = false;
  let index = 0;

  while (index < buffer.length) {
    const char = buffer[index];
    if (char === '(') {
      const parsed = parsePdfString(buffer, index);
      if (!parsed) {
        index += 1;
        continue;
      }
      const nextTokenIndex = skipWhitespace(buffer, parsed.end);
      if (buffer.slice(nextTokenIndex, nextTokenIndex + 2) === 'Tj') {
        if (before.length && parsed.text.includes(before)) {
          const updated = parsed.text.split(before).join(after);
          const encodedAfter = encodePdfString(updated);
          buffer = buffer.slice(0, parsed.start) + encodedAfter + buffer.slice(parsed.end);
          index = parsed.start + encodedAfter.length;
          replaced = true;
          continue;
        }
      }
      index = parsed.end;
      continue;
    }
    if (char === '[') {
      const parsedArray = parseTextArray(buffer, index);
      if (!parsedArray) {
        index += 1;
        continue;
      }
      const nextTokenIndex = skipWhitespace(buffer, parsedArray.end);
      if (buffer.slice(nextTokenIndex, nextTokenIndex + 2) === 'TJ') {
        const { literal, replaced: arrayReplaced } = replaceInTextArray(parsedArray.tokens, before, after);
        if (arrayReplaced) {
          buffer = buffer.slice(0, parsedArray.start) + literal + buffer.slice(parsedArray.end);
          index = parsedArray.start + literal.length;
          replaced = true;
          continue;
        }
      }
      index = parsedArray.end;
      continue;
    }
    index += 1;
  }

  return { stream: buffer, replaced };
}

type TextArrayToken =
  | { type: 'string'; value: string }
  | { type: 'number'; raw: string };

function replaceInTextArray(tokens: TextArrayToken[], before: string, after: string): { literal: string; replaced: boolean } {
  let replaced = false;
  const stringTokens = tokens.filter((token): token is { type: 'string'; value: string } => token.type === 'string');

  stringTokens.forEach(token => {
    if (token.value.includes(before)) {
      token.value = token.value.split(before).join(after);
      replaced = true;
    }
  });

  if (!replaced && before.length > 1 && stringTokens.length > 1) {
    for (let start = 0; start < stringTokens.length; start++) {
      let combined = '';
      const sequence: number[] = [];
      for (let offset = start; offset < stringTokens.length; offset++) {
        combined += stringTokens[offset].value;
        sequence.push(offset);
        if (!before.startsWith(combined)) {
          break;
        }
        if (combined === before) {
          stringTokens[sequence[0]].value = after;
          for (let i = 1; i < sequence.length; i++) {
            stringTokens[sequence[i]].value = '';
          }
          replaced = true;
          break;
        }
      }
      if (replaced) {
        break;
      }
    }
  }

  const literal = `[ ${tokens
    .map(token => (token.type === 'string' ? encodePdfString(token.value) : token.raw))
    .join(' ')} ]`;

  return { literal, replaced };
}

function parsePdfString(source: string, start: number): { start: number; end: number; text: string } | null {
  let index = start + 1;
  let text = '';
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      if (index + 1 >= source.length) {
        break;
      }
      const next = source[index + 1];
      if (/^[0-7]$/.test(next)) {
        const match = source.slice(index + 1, index + 4).match(/^[0-7]{1,3}/);
        if (match) {
          const code = parseInt(match[0], 8);
          text += String.fromCharCode(code);
          index += match[0].length + 1;
          continue;
        }
      }
      switch (next) {
        case 'n':
          text += '\n';
          break;
        case 'r':
          text += '\r';
          break;
        case 't':
          text += '\t';
          break;
        case 'b':
          text += '\b';
          break;
        case 'f':
          text += '\f';
          break;
        case '(':
          text += '(';
          break;
        case ')':
          text += ')';
          break;
        case '\\':
          text += '\\';
          break;
        default:
          text += next;
          break;
      }
      index += 2;
      continue;
    }
    if (char === ')') {
      return { start, end: index + 1, text };
    }
    text += char;
    index += 1;
  }
  return null;
}

function parseTextArray(source: string, start: number): { start: number; end: number; tokens: TextArrayToken[] } | null {
  let index = start + 1;
  const tokens: TextArrayToken[] = [];
  while (index < source.length) {
    const char = source[index];
    if (char === ']') {
      return { start, end: index + 1, tokens };
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '(') {
      const parsed = parsePdfString(source, index);
      if (!parsed) {
        return null;
      }
      tokens.push({ type: 'string', value: parsed.text });
      index = parsed.end;
      continue;
    }
    const numberMatch = source.slice(index).match(/^[+-]?(?:\d+\.?\d*|\.\d+)/);
    if (numberMatch) {
      tokens.push({ type: 'number', raw: numberMatch[0] });
      index += numberMatch[0].length;
      continue;
    }
    index += 1;
  }
  return null;
}

function skipWhitespace(source: string, index: number): number {
  let position = index;
  while (position < source.length && /\s/.test(source[position])) {
    position += 1;
  }
  return position;
}

function encodePdfString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
  return `(${escaped})`;
}

function buildFallbackStream(
  page: any,
  text: string,
  context: ReplacementContext
): any | null {
  if (!text.length) {
    return null;
  }
  const fontSize = context.fontSize ?? 12;
  const sourceTransform = context.transform ?? [1, 0, 0, 1, context.bbox?.[0] ?? 0, context.bbox?.[1] ?? 0];
  const transform = sourceTransform.length >= 6
    ? sourceTransform.slice(0, 6)
    : [...sourceTransform, ...Array(6 - sourceTransform.length).fill(0)];
  const pageResources = page['/Resources'] || (page['/Resources'] = {});
  const fonts = pageResources['/Font'] || (pageResources['/Font'] = {});
  const fontKey = '/PDFAssemblerFallbackFont';
  if (!fonts[fontKey]) {
    fonts[fontKey] = {
      '/Type': '/Font',
      '/Subtype': '/Type1',
      '/BaseFont': '/Helvetica'
    };
  }
  const encodedText = encodePdfString(text);
  const stream = `q BT ${transform.slice(0, 6).join(' ')} Tm ${fontKey} ${fontSize} Tf ${encodedText} Tj ET Q`;
  return { stream };
}

export async function exportEdited(): Promise<ArrayBuffer> {
  if (!assembler) {
    throw new Error('PDF assembler not initialized');
  }
  await assembler.removeRootEntries();
  return assembler.assemblePdf('ArrayBuffer') as Promise<ArrayBuffer>;
}

export function getOriginalBuffer(): ArrayBuffer | null {
  return sourceBuffer;
}
