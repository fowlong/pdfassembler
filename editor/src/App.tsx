import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  countPages,
  createAssembler,
  exportEdited,
  getPDFDocument,
  getPDFStructure,
  replaceTextOnPage,
  type ReplacementContext,
  type ReplacementResult
} from './pdfBridge';
import {
  buildTextIndex,
  searchIndex,
  type IndexedPage,
  type TextIndexItem
} from './textIndex';
import { createOverlayController } from './overlay';

declare global {
  interface Window {
    EmbedPDF?: {
      embed: (options: { url: string; container: string | HTMLElement; page?: number }) => {
        setPage?: (page: number) => void;
        destroy?: () => void;
      } | void;
    };
  }
}

const DEFAULT_MEDIA_BOX: [number, number, number, number] = [0, 0, 612, 792];

interface StatusMessage {
  type: 'info' | 'error' | 'success';
  text: string;
}

const App: React.FC = () => {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState<number>(0);
  const [indexedPages, setIndexedPages] = useState<IndexedPage[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPage, setSelectedPage] = useState(0);
  const [selectedItem, setSelectedItem] = useState<TextIndexItem | null>(null);
  const [replacementText, setReplacementText] = useState('');
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [isBusy, setBusy] = useState(false);
  const [mediaBoxes, setMediaBoxes] = useState<[number, number, number, number][]>([]);

  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const embedInstanceRef = useRef<{ setPage?: (page: number) => void; destroy?: () => void } | null>(null);
  const overlayController = useMemo(() => createOverlayController(), []);

  const availableItems = useMemo(() => {
    if (!indexedPages.length) {
      return [] as TextIndexItem[];
    }
    if (searchQuery.trim().length === 0) {
      return indexedPages[selectedPage]?.items ?? [];
    }
    return searchIndex(indexedPages, searchQuery.trim());
  }, [indexedPages, searchQuery, selectedPage]);

  useEffect(() => {
    if (viewerContainerRef.current) {
      overlayController.mount(viewerContainerRef.current);
    }
  }, [overlayController]);

  useEffect(() => {
    if (!pdfUrl || !viewerContainerRef.current) {
      return;
    }
    if (embedInstanceRef.current?.destroy) {
      embedInstanceRef.current.destroy();
      embedInstanceRef.current = null;
    }
    const container = '#embed-viewer';
    const instance = window.EmbedPDF?.embed({
      url: pdfUrl,
      container,
      page: selectedPage + 1
    });
    if (instance) {
      embedInstanceRef.current = instance;
    }
    return () => {
      if (embedInstanceRef.current?.destroy) {
        embedInstanceRef.current.destroy();
        embedInstanceRef.current = null;
      }
    };
  }, [pdfUrl]);

  useEffect(() => {
    if (selectedItem) {
      setReplacementText(selectedItem.text);
      const mediaBox = mediaBoxes[selectedItem.pageIndex] ?? DEFAULT_MEDIA_BOX;
      overlayController.highlight(selectedItem, mediaBox);
    } else {
      overlayController.clear();
    }
  }, [selectedItem, overlayController, mediaBoxes]);

  useEffect(() => {
    if (embedInstanceRef.current?.setPage) {
      embedInstanceRef.current.setPage(selectedPage + 1);
    } else if (pdfUrl) {
      window.EmbedPDF?.embed({
        url: pdfUrl,
        container: '#embed-viewer',
        page: selectedPage + 1
      });
    }
  }, [selectedPage, pdfUrl]);

  const resetState = () => {
    setPageCount(0);
    setIndexedPages([]);
    setSearchQuery('');
    setSelectedPage(0);
    setSelectedItem(null);
    setReplacementText('');
    setStatus(null);
    setMediaBoxes([]);
    if (pdfUrl) {
      URL.revokeObjectURL(pdfUrl);
    }
    setPdfUrl(null);
  };

  const handleFileSelection: React.ChangeEventHandler<HTMLInputElement> = async event => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    resetState();
    setBusy(true);
    setStatus({ type: 'info', text: 'Loading PDF…' });
    try {
      const arrayBuffer = await file.arrayBuffer();
      await createAssembler(arrayBuffer);
      const [pages, totalPages, document] = await Promise.all([
        Promise.resolve(getPDFStructure()['/Root']['/Pages']['/Kids'] as any[]),
        countPages(),
        Promise.resolve(getPDFDocument())
      ]);
      setPageCount(totalPages);
      setMediaBoxes(
        pages.map(page =>
          Array.isArray(page['/MediaBox']) && page['/MediaBox'].length === 4
            ? (page['/MediaBox'] as [number, number, number, number])
            : DEFAULT_MEDIA_BOX
        )
      );
      const textIndex = await buildTextIndex(document);
      setIndexedPages(textIndex);
      setSelectedPage(0);
      setSelectedItem(null);
      const url = URL.createObjectURL(new Blob([arrayBuffer]));
      setPdfUrl(url);
      setStatus({ type: 'success', text: 'PDF loaded successfully.' });
    } catch (error) {
      console.error(error);
      setStatus({ type: 'error', text: 'Failed to load PDF. Please try another file.' });
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  };

  const handleSearchChange: React.ChangeEventHandler<HTMLInputElement> = event => {
    setSearchQuery(event.target.value);
  };

  const handleSelectItem = (item: TextIndexItem) => {
    setSelectedItem(item);
    setSelectedPage(item.pageIndex);
  };

  const handleReplace = async () => {
    if (!selectedItem) {
      return;
    }
    setBusy(true);
    setStatus({ type: 'info', text: 'Applying text replacement…' });
    const context: ReplacementContext = {
      bbox: selectedItem.bbox,
      transform: selectedItem.transform,
      fontSize: selectedItem.fontSize
    };
    try {
      const result: ReplacementResult = await replaceTextOnPage(
        selectedItem.pageIndex,
        selectedItem.text,
        replacementText,
        context
      );
      const shouldUpdateText = result !== 'skipped' && (result === 'replaced' || replacementText.length > 0);
      if (shouldUpdateText) {
        setIndexedPages(prev =>
          prev.map(page =>
            page.pageIndex === selectedItem.pageIndex
              ? {
                  ...page,
                  items: page.items.map(item =>
                    item.id === selectedItem.id
                      ? { ...item, text: replacementText }
                      : item
                  )
                }
              : page
          )
        );
        setSelectedItem(prev =>
          prev ? { ...prev, text: replacementText } : prev
        );
      }
      if (result === 'replaced') {
        setStatus({ type: 'success', text: 'Replacement applied.' });
      } else if (result === 'fallback') {
        setStatus({ type: 'info', text: 'Original tokens not found. A fallback overlay stream has been appended.' });
      } else {
        setStatus({ type: 'error', text: 'Unable to locate the requested text tokens.' });
      }
    } catch (error) {
      console.error(error);
      setStatus({ type: 'error', text: 'Failed to replace text.' });
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    setBusy(true);
    setStatus({ type: 'info', text: 'Preparing edited PDF…' });
    try {
      const arrayBuffer = await exportEdited();
      const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'edited.pdf';
      link.click();
      URL.revokeObjectURL(link.href);
      setStatus({ type: 'success', text: 'Download started.' });
    } catch (error) {
      console.error(error);
      setStatus({ type: 'error', text: 'Failed to export PDF.' });
    } finally {
      setBusy(false);
    }
  };

  const handleReset = () => {
    resetState();
  };

  return (
    <div className="app-shell">
      <div className="toolbar">
        <label>
          <span style={{ marginRight: '0.5rem' }}>Open PDF:</span>
          <input type="file" accept="application/pdf" onChange={handleFileSelection} disabled={isBusy} />
        </label>
        <button className="secondary" onClick={handleReset} disabled={!pdfUrl || isBusy}>
          Reset
        </button>
        <button className="primary" onClick={handleExport} disabled={!pdfUrl || isBusy}>
          Export edited PDF
        </button>
        {status && <span style={{ marginLeft: 'auto', color: status.type === 'error' ? '#d93025' : '#0d6efd' }}>{status.text}</span>}
      </div>

      <aside className="sidebar">
        <header>Pages</header>
        <div className="page-list">
          {Array.from({ length: pageCount }).map((_, index) => (
            <button
              key={index}
              className={index === selectedPage ? 'active' : ''}
              onClick={() => setSelectedPage(index)}
            >
              Page {index + 1}
            </button>
          ))}
          {!pageCount && <div className="empty-state">Load a PDF to see its pages.</div>}
        </div>

        <div className="text-search">
          <header>Search text</header>
          <input
            type="search"
            placeholder="Search text content"
            value={searchQuery}
            onChange={handleSearchChange}
            disabled={!pdfUrl}
          />
          <div className="text-list">
            {availableItems.map(item => (
              <div
                key={item.id}
                className={`text-item ${selectedItem?.id === item.id ? 'active' : ''}`}
                onClick={() => handleSelectItem(item)}
              >
                <div>{item.text || <em>(whitespace)</em>}</div>
                <small>Page {item.pageIndex + 1}</small>
              </div>
            ))}
            {!availableItems.length && <div className="empty-state">No text matches.</div>}
          </div>
        </div>
      </aside>

      <section className="viewer">
        {pdfUrl ? (
          <div className="viewer-container" ref={viewerContainerRef}>
            <div id="embed-viewer" />
          </div>
        ) : (
          <div className="empty-state">
            <h2>Drop a PDF to begin editing</h2>
            <p>The PDF will render in the viewer and its text content will be indexed for quick search.</p>
          </div>
        )}
      </section>

      <section className="inspector">
        <header>Editor</header>
        {selectedItem ? (
          <>
            <div>
              <label>Original text</label>
              <textarea readOnly value={selectedItem.text} />
            </div>
            <div>
              <label>Replacement</label>
              <textarea value={replacementText} onChange={event => setReplacementText(event.target.value)} />
            </div>
            <div className="actions">
              <button className="primary" onClick={handleReplace} disabled={isBusy}>
                Apply replacement
              </button>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <p>Select a text snippet from the list to edit it here.</p>
          </div>
        )}
      </section>
    </div>
  );
};

export default App;
