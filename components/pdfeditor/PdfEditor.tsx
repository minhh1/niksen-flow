// components/pdfeditor/PdfEditor.tsx
// Top-level PDF editor: loads the document via pdfjs-dist, owns page navigation,
// the toolbar/active tool, the edit-op undo/redo stack, and Save (flattens via
// lib/pdfeditor/applyEdits.ts and PUTs the result, then reloads it as the new
// baseline so further edits — including re-editing text you just changed — work
// against the saved PDF).
//
// A freshly picked/dropped file (source.kind === "new") is opened straight from
// the browser's File object — no upload happens until the first Save, at which
// point it's created in the bucket for the first time and this component starts
// tracking its documentId so subsequent Saves are PUTs against it. Opening a
// previously-saved document (source.kind === "existing") still goes through the
// signed-URL fetch as before.
"use client";

import "pdfjs-dist/web/pdf_viewer.css";
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  ArrowLeft, MousePointer2, Type, Highlighter, Pencil, PenTool,
  Undo2, Redo2, Save, ZoomIn, ZoomOut, Loader2, Trash2, Download,
} from "lucide-react";
import PdfPageView from "./PdfPageView";
import SignaturePad from "./SignaturePad";
import { applyEdits } from "@/lib/pdfeditor/applyEdits";
import type { PdfEditOp, ToolId } from "@/lib/pdfeditor/types";

export type PdfSource = { kind: "existing"; documentId: string } | { kind: "new"; file: File };

interface Props {
  source: PdfSource;
  onBack: () => void;
}

const TOOLS: { id: ToolId; label: string; icon: any }[] = [
  { id: "select", label: "Select / edit text", icon: MousePointer2 },
  { id: "textbox", label: "Add text box", icon: Type },
  { id: "highlight", label: "Highlight", icon: Highlighter },
  { id: "draw", label: "Draw", icon: Pencil },
  { id: "signature", label: "Signature", icon: PenTool },
];

export default function PdfEditor({ source, onBack }: Props) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [docName, setDocName] = useState("");
  const [documentId, setDocumentId] = useState<string | null>(source.kind === "existing" ? source.documentId : null);

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pages, setPages] = useState<PDFPageProxy[]>([]);
  const [currentPage, setCurrentPage] = useState(0); // 0-indexed, tracked from scroll position
  const [scale, setScale] = useState(1.4);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageWrapperRefs = useRef<(HTMLDivElement | null)[]>([]);

  const [ops, setOps] = useState<PdfEditOp[]>([]);
  const [history, setHistory] = useState<PdfEditOp[][]>([]);
  const [future, setFuture] = useState<PdfEditOp[][]>([]);
  const [activeTool, setActiveTool] = useState<ToolId>("select");
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const [pendingSignature, setPendingSignature] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const originalBytesRef = useRef<Uint8Array | null>(null);

  // ── Load the document ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        let buf: Uint8Array;
        if (source.kind === "existing") {
          const res = await fetch(`/api/pdf-editor/${source.documentId}`);
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || "Could not load this document");
          if (cancelled) return;
          setDocName(json.document.name);

          const fileRes = await fetch(json.url);
          buf = new Uint8Array(await fileRes.arrayBuffer());
        } else {
          setDocName(source.file.name.replace(/\.pdf$/i, ""));
          buf = new Uint8Array(await source.file.arrayBuffer());
        }
        if (cancelled) return;
        originalBytesRef.current = buf;

        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const doc = await pdfjsLib.getDocument({ data: buf.slice() }).promise;
        if (cancelled) return;
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setCurrentPage(0);
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message || "Failed to load PDF");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind === "existing" ? source.documentId : source.file]);

  // ── Load every page proxy up front so they can render as one continuous scroll ──
  useEffect(() => {
    if (!pdfDoc) { setPages([]); return; }
    let cancelled = false;
    (async () => {
      const loaded = await Promise.all(
        Array.from({ length: pdfDoc.numPages }, (_, i) => pdfDoc.getPage(i + 1))
      );
      if (!cancelled) setPages(loaded);
    })();
    return () => { cancelled = true; };
  }, [pdfDoc]);

  // ── Track which page is most visible to drive the page-number indicator ──
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || pages.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        let best: { idx: number; ratio: number } | null = null;
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.pageIdx);
          if (entry.isIntersecting && (!best || entry.intersectionRatio > best.ratio)) {
            best = { idx, ratio: entry.intersectionRatio };
          }
        }
        if (best) setCurrentPage(best.idx);
      },
      { root: container, threshold: [0.25, 0.5, 0.75] }
    );
    pageWrapperRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [pages, scale]);

  const scrollToPage = (idx: number) => {
    pageWrapperRefs.current[idx]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleAddOp = (op: PdfEditOp) => {
    setHistory((h) => [...h, ops]);
    setFuture([]);
    setOps((prev) => {
      const filtered = op.type === "text-edit"
        ? prev.filter((o) => !(o.type === "text-edit" && o.page === op.page && o.itemIndex === op.itemIndex))
        : prev;
      return [...filtered, op];
    });
  };

  // Used for drag-move / resize (called once at drag end — the drag itself is
  // a purely visual CSS transform in PdfPageView, no ops churn per pointer-move)
  // and for discrete edits like bold/italic/underline toggles. Each call is a
  // single atomic, undo-able mutation.
  const handleUpdateOp = (id: string, patch: Partial<PdfEditOp>) => {
    setHistory((h) => [...h, ops]);
    setFuture([]);
    setOps((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } as PdfEditOp : o)));
  };

  const handleDeleteOp = (id: string) => {
    setHistory((h) => [...h, ops]);
    setFuture([]);
    setOps((prev) => prev.filter((o) => o.id !== id));
  };

  const undo = () => {
    if (!history.length) return;
    const prevOps = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [...f, ops]);
    setOps(prevOps);
  };
  const redo = () => {
    if (!future.length) return;
    const nextOps = future[future.length - 1];
    setFuture((f) => f.slice(0, -1));
    setHistory((h) => [...h, ops]);
    setOps(nextOps);
  };

  const handleSave = async () => {
    if (!originalBytesRef.current) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const newBytes = await applyEdits(originalBytesRef.current, ops);

      if (!documentId) {
        // First save of a locally-opened file: create it in the bucket now.
        const form = new FormData();
        form.append("file", new Blob([newBytes as unknown as BlobPart], { type: "application/pdf" }), `${docName || "document"}.pdf`);
        form.append("name", docName || "Untitled");
        const res = await fetch("/api/pdf-editor/upload", { method: "POST", body: form });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Save failed");
        setDocumentId(json.document.id);
      } else {
        const res = await fetch(`/api/pdf-editor/${documentId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/pdf" },
          body: new Blob([newBytes as unknown as BlobPart], { type: "application/pdf" }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || "Save failed");
        }
      }

      originalBytesRef.current = newBytes;
      setOps([]); setHistory([]); setFuture([]);

      const pdfjsLib = await import("pdfjs-dist");
      const doc = await pdfjsLib.getDocument({ data: newBytes.slice() }).promise;
      setPdfDoc(doc);
      setNumPages(doc.numPages);
      setCurrentPage((p) => Math.min(p, doc.numPages - 1));
      setSaveMsg("Saved");
    } catch (e: any) {
      setSaveMsg(e?.message || "Save failed");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 4000);
    }
  };

  const handleDownload = async () => {
    if (!originalBytesRef.current) return;
    const bytes = ops.length ? await applyEdits(originalBytesRef.current, ops) : originalBytesRef.current;
    const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${docName || "document"}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDelete = async () => {
    if (!documentId) { onBack(); return; } // never saved — nothing in the bucket to remove
    if (!confirm("Delete this PDF? This can't be undone.")) return;
    setDeleting(true);
    try {
      await fetch(`/api/pdf-editor/${documentId}`, { method: "DELETE" });
      onBack();
    } finally {
      setDeleting(false);
    }
  };

  const selectTool = (tool: ToolId) => {
    if (tool === "signature") {
      setShowSignaturePad(true);
      return;
    }
    setActiveTool(tool);
  };

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">
      <header className="bg-white p-4 border-b border-slate-100 shrink-0 flex items-center gap-4">
        <button onClick={onBack} className="p-2 hover:bg-slate-50 rounded-full transition-all text-slate-400">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-[15px] font-semibold text-slate-900 truncate">{docName || "PDF Editor"}</h1>
        </div>

        {!loading && !loadError && (
          <>
            <div className="flex items-center gap-1 bg-slate-100 rounded-full p-1">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  title={t.label}
                  onClick={() => selectTool(t.id)}
                  className={`p-2 rounded-full transition-all ${activeTool === t.id ? "bg-white shadow-sm text-slate-900" : "text-slate-400 hover:text-slate-700"}`}
                >
                  <t.icon size={16} />
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1">
              <button title="Undo" onClick={undo} disabled={!history.length} className="p-2 rounded-full text-slate-400 hover:text-slate-700 disabled:opacity-30">
                <Undo2 size={16} />
              </button>
              <button title="Redo" onClick={redo} disabled={!future.length} className="p-2 rounded-full text-slate-400 hover:text-slate-700 disabled:opacity-30">
                <Redo2 size={16} />
              </button>
            </div>

            <div className="flex items-center gap-1">
              <button title="Zoom out" onClick={() => setScale((s) => Math.max(0.5, s - 0.2))} className="p-2 rounded-full text-slate-400 hover:text-slate-700">
                <ZoomOut size={16} />
              </button>
              <button title="Zoom in" onClick={() => setScale((s) => Math.min(3, s + 0.2))} className="p-2 rounded-full text-slate-400 hover:text-slate-700">
                <ZoomIn size={16} />
              </button>
            </div>

            {saveMsg && <span className="text-[11px] font-medium text-slate-400">{saveMsg}</span>}
            <button
              title="Download PDF"
              onClick={handleDownload}
              className="p-2 rounded-full text-slate-400 hover:text-slate-700"
            >
              <Download size={16} />
            </button>
            <button
              title={documentId ? "Delete this PDF" : "Discard"}
              onClick={handleDelete}
              disabled={deleting}
              className="p-2 rounded-full text-slate-400 hover:text-red-500 disabled:opacity-30"
            >
              {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 text-[12px] font-medium bg-slate-900 text-white rounded-full disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </button>
          </>
        )}
      </header>

      <main ref={scrollContainerRef} className="flex-1 min-h-0 overflow-auto flex flex-col items-center gap-6 p-8 relative">
        {loading && (
          <div className="flex items-center gap-2 text-slate-400 text-[13px] mt-20">
            <Loader2 size={16} className="animate-spin" /> Loading PDF…
          </div>
        )}
        {loadError && <div className="text-[13px] text-red-500 mt-20">{loadError}</div>}

        {!loading && !loadError && pages.map((page, idx) => (
          <div key={idx} ref={(el) => { pageWrapperRefs.current[idx] = el; }} data-page-idx={idx}>
            <PdfPageView
              pdfPage={page}
              pageIndex={idx}
              scale={scale}
              ops={ops}
              activeTool={activeTool}
              pendingSignature={pendingSignature}
              onAddOp={handleAddOp}
              onUpdateOp={handleUpdateOp}
              onDeleteOp={handleDeleteOp}
              onPlacementComplete={() => { setPendingSignature(null); setActiveTool("select"); }}
            />
          </div>
        ))}

        {!loading && !loadError && numPages > 1 && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 text-[12px] text-slate-500 bg-white/95 backdrop-blur px-4 py-2 rounded-full shadow-lg border border-slate-100">
            <button
              onClick={() => scrollToPage(Math.max(0, currentPage - 1))}
              disabled={currentPage === 0}
              className="px-3 py-1.5 rounded-full bg-white border border-slate-200 disabled:opacity-40"
            >
              Prev
            </button>
            <span>Page {currentPage + 1} of {numPages}</span>
            <button
              onClick={() => scrollToPage(Math.min(numPages - 1, currentPage + 1))}
              disabled={currentPage === numPages - 1}
              className="px-3 py-1.5 rounded-full bg-white border border-slate-200 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </main>

      {showSignaturePad && (
        <SignaturePad
          onCancel={() => setShowSignaturePad(false)}
          onDone={(dataUrl) => {
            setPendingSignature(dataUrl);
            setActiveTool("signature");
            setShowSignaturePad(false);
          }}
        />
      )}

      {activeTool === "signature" && pendingSignature && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-[12px] px-4 py-2 rounded-full shadow-lg">
          Click on the page to place your signature
        </div>
      )}
    </div>
  );
}
