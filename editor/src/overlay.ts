import type { TextIndexItem } from './textIndex';

export interface OverlayController {
  mount(container: HTMLElement): void;
  highlight(item: TextIndexItem | null, mediaBox?: number[]): void;
  clear(): void;
}

function ensureOverlayRoot(container: HTMLElement): HTMLDivElement {
  let overlay = container.querySelector<HTMLDivElement>('.overlay-root');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'overlay-root';
    container.appendChild(overlay);
  }
  return overlay;
}

function removeChildren(node: HTMLElement) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function mapToCss(
  bbox: [number, number, number, number],
  mediaBox: number[],
  container: DOMRect
) {
  const [xMin, yMin, xMax, yMax] = bbox;
  const [boxX0, boxY0, boxX1, boxY1] = mediaBox;
  const widthPts = boxX1 - boxX0;
  const heightPts = boxY1 - boxY0;
  if (widthPts === 0 || heightPts === 0) {
    return null;
  }
  const scaleX = container.width / widthPts;
  const scaleY = container.height / heightPts;
  const left = (xMin - boxX0) * scaleX;
  const top = (boxY1 - yMax) * scaleY;
  const width = (xMax - xMin) * scaleX;
  const height = (yMax - yMin) * scaleY;
  return { left, top, width, height };
}

export function createOverlayController(): OverlayController {
  let container: HTMLElement | null = null;
  let mediaBox: number[] | undefined;

  return {
    mount(target: HTMLElement) {
      container = target;
    },
    highlight(item: TextIndexItem | null, pageMediaBox?: number[]) {
      if (!container) {
        return;
      }
      const overlayRoot = ensureOverlayRoot(container);
      removeChildren(overlayRoot);
      if (!item || !pageMediaBox) {
        return;
      }
      mediaBox = pageMediaBox;
      const rect = container.getBoundingClientRect();
      const css = mapToCss(item.bbox, mediaBox, rect);
      if (!css) {
        return;
      }
      const element = document.createElement('div');
      element.className = 'overlay-rect';
      element.style.left = `${css.left}px`;
      element.style.top = `${css.top}px`;
      element.style.width = `${css.width}px`;
      element.style.height = `${css.height}px`;
      overlayRoot.appendChild(element);
    },
    clear() {
      if (!container) {
        return;
      }
      const overlayRoot = ensureOverlayRoot(container);
      removeChildren(overlayRoot);
    }
  };
}
