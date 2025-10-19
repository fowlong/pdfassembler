import type { PDFDocumentProxy, PDFPageProxy, TextContent, TextItem } from 'pdfjs-dist';

export interface TextIndexItem {
  id: string;
  text: string;
  bbox: [number, number, number, number];
  transform: number[];
  fontSize: number;
  width: number;
  height: number;
  pageIndex: number;
}

export interface IndexedPage {
  pageIndex: number;
  items: TextIndexItem[];
}

function toBoundingBox(item: TextItem): [number, number, number, number] {
  const [a, b, c, d, e, f] = item.transform;
  const width = item.width || Math.hypot(a, b);
  const height = item.height || Math.hypot(c, d);
  const xMin = e;
  const yMax = f;
  const xMax = xMin + width;
  const yMin = yMax - height;
  return [xMin, yMin, xMax, yMax];
}

function toTextIndexItem(pageIndex: number, item: TextItem, index: number): TextIndexItem {
  return {
    id: `${pageIndex + 1}-${index}`,
    text: item.str,
    bbox: toBoundingBox(item),
    transform: item.transform.slice(0, 6),
    fontSize: item.fontSize || Math.hypot(item.transform[0], item.transform[1]),
    width: item.width,
    height: item.height,
    pageIndex
  };
}

async function indexPage(page: PDFPageProxy, pageIndex: number): Promise<IndexedPage> {
  const textContent: TextContent = await page.getTextContent();
  const items = textContent.items
    .filter((item): item is TextItem => (item as TextItem).str !== undefined)
    .map((item, index) => toTextIndexItem(pageIndex, item, index));
  return { pageIndex, items };
}

export async function buildTextIndex(document: PDFDocumentProxy): Promise<IndexedPage[]> {
  const count = document.numPages;
  const results: IndexedPage[] = [];
  for (let pageNumber = 1; pageNumber <= count; pageNumber++) {
    const page = await document.getPage(pageNumber);
    results.push(await indexPage(page, pageNumber - 1));
  }
  return results;
}

export function searchIndex(pages: IndexedPage[], query: string): TextIndexItem[] {
  if (!query.length) {
    return pages.flatMap(page => page.items);
  }
  const normalized = query.toLowerCase();
  return pages.flatMap(page =>
    page.items.filter(item => item.text.toLowerCase().includes(normalized))
  );
}
