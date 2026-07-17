// components/pdfeditor/PdfPageView.tsx
// Renders one PDF page: the pdf.js canvas bitmap, pdf.js's own TextLayer (correctly
// positioned per-run text spans — reused rather than hand-computing span boxes),
// an overlay for committed annotations (highlight/textbox/draw/signature), and an
// interaction layer that captures pointer events for the active annotation tool.
// All PDF-space <-> screen-space conversion goes through the page's pdf.js
// viewport (convertToPdfPoint / convertToViewportPoint) — no hand-rolled matrices.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFPageProxy } from "pdfjs-dist";
import type { DrawOp, HighlightOp, ImageOp, PdfEditOp, TextBoxOp, ToolId } from "@/lib/pdfeditor/types";
import { matchStandardFont, isBoldFont, isItalicFont, withBoldItalic } from "@/lib/pdfeditor/fontMatch";
import type { StandardFontKey } from "@/lib/pdfeditor/types";

// pdfjs-dist doesn't re-export TextContent/TextItem from its top-level types
// module — shapes mirrored here from display/api.d.ts (str/transform/width/
// height/fontName/hasEOL, plus the page's fontName -> fontFamily style map).
interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}
interface PdfTextContent {
  items: (PdfTextItem | Record<string, unknown>)[];
  styles: Record<string, { fontFamily: string; ascent: number; descent: number; vertical: boolean }>;
}

interface Props {
  pdfPage: PDFPageProxy;
  pageIndex: number; // 0-indexed
  scale: number;
  ops: PdfEditOp[]; // all pages' ops
  activeTool: ToolId;
  pendingSignature: string | null;
  onAddOp: (op: PdfEditOp) => void;
  onUpdateOp: (id: string, patch: Partial<PdfEditOp>) => void; // reposition/resize/reformat an existing op
  onDeleteOp: (id: string) => void;
  onPlacementComplete: () => void; // called after a discrete placement (textbox/signature) so the toolbar can revert to "select"
}

function opBoundingBox(viewport: any, o: HighlightOp | TextBoxOp | ImageOp | DrawOp, scale: number) {
  if (o.type === "highlight" || o.type === "image") return pdfRectToScreen(viewport, o.x, o.y, o.width, o.height);
  if (o.type === "textbox") {
    const [sx, sy] = viewport.convertToViewportPoint(o.x, o.y);
    const approxWidth = o.text.length * o.fontSize * scale * 0.55;
    return { left: sx, top: sy - o.fontSize * scale, width: approxWidth, height: o.fontSize * scale * 1.2 };
  }
  const screenPts = o.points.map((p) => viewport.convertToViewportPoint(p.x, p.y));
  const xs = screenPts.map((p: number[]) => p[0]);
  const ys = screenPts.map((p: number[]) => p[1]);
  return { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function pdfRectToScreen(viewport: any, x: number, y: number, width: number, height: number) {
  const [sx1, sy1] = viewport.convertToViewportPoint(x, y);
  const [sx2, sy2] = viewport.convertToViewportPoint(x + width, y + height);
  return {
    left: Math.min(sx1, sx2), top: Math.min(sy1, sy2),
    width: Math.abs(sx2 - sx1), height: Math.abs(sy2 - sy1),
  };
}

const rgbCss = (c: [number, number, number]) => `rgb(${c[0] * 255}, ${c[1] * 255}, ${c[2] * 255})`;

export default function PdfPageView({
  pdfPage, pageIndex, scale, ops, activeTool, pendingSignature, onAddOp, onMoveOp, onDeleteOp, onPlacementComplete,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  // ── Annotation selection / drag / delete (select tool only) ─────────────
  const [selectedOpId, setSelectedOpId] = useState<string | null>(null);
  const dragStateRef = useRef<{ id: string; startClientX: number; startClientY: number; startX: number; startY: number; moved: boolean } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ id: string; dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (activeTool !== "select") setSelectedOpId(null);
  }, [activeTool]);

  useEffect(() => {
    if (!selectedOpId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const active = document.activeElement;
      const isEditingText = active instanceof HTMLElement && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      if (isEditingText) return;
      onDeleteOp(selectedOpId);
      setSelectedOpId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedOpId, onDeleteOp]);

  const beginDrag = (id: string, startX: number, startY: number, e: React.PointerEvent) => {
    if (activeTool !== "select") return;
    e.stopPropagation();
    setSelectedOpId(id);
    dragStateRef.current = { id, startClientX: e.clientX, startClientY: e.clientY, startX, startY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    const ds = dragStateRef.current;
    if (!ds) return;
    const dx = e.clientX - ds.startClientX;
    const dy = e.clientY - ds.startClientY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) ds.moved = true;
    setDragOffset({ id: ds.id, dx, dy });
  };
  const onDragEnd = (e: React.PointerEvent) => {
    const ds = dragStateRef.current;
    if (!ds) return;
    dragStateRef.current = null;
    setDragOffset(null);
    if (!ds.moved) return;
    const dx = e.clientX - ds.startClientX;
    const dy = e.clientY - ds.startClientY;
    const [origSx, origSy] = viewport.convertToViewportPoint(ds.startX, ds.startY);
    const [newX, newY] = viewport.convertToPdfPoint(origSx + dx, origSy + dy);
    onMoveOp(ds.id, newX, newY);
  };

  function DeleteBadge({ id }: { id: string }) {
    if (selectedOpId !== id) return null;
    return (
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onDeleteOp(id); setSelectedOpId(null); }}
        title="Delete"
        style={{
          position: "absolute", top: -8, right: -8, width: 18, height: 18, borderRadius: 9999,
          background: "#1e293b", color: "white", fontSize: 12, lineHeight: "16px", textAlign: "center",
          cursor: "pointer", border: "2px solid white", boxShadow: "0 1px 3px rgba(0,0,0,0.3)", padding: 0,
        }}
      >
        ×
      </button>
    );
  }

  const contentRef = useRef<PdfTextContent | null>(null);
  const textDivsRef = useRef<HTMLElement[]>([]);
  const textItemsRef = useRef<PdfTextItem[]>([]);
  const editingIndexRef = useRef<number | null>(null);

  // Read via refs inside long-lived span click handlers to avoid stale closures.
  const activeToolRef = useRef(activeTool);
  const opsRef = useRef(ops);
  const onAddOpRef = useRef(onAddOp);
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { opsRef.current = ops; }, [ops]);
  useEffect(() => { onAddOpRef.current = onAddOp; }, [onAddOp]);

  const viewport = useMemo(() => pdfPage.getViewport({ scale }), [pdfPage, scale]);
  const pageOps = useMemo(() => ops.filter((o) => o.page === pageIndex), [ops, pageIndex]);

  // ── Render canvas bitmap + pdf.js TextLayer ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    let renderTask: any;
    let textLayer: any;

    (async () => {
      try {
        setReady(false);
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        renderTask = pdfPage.render({ canvas, viewport });
        await renderTask.promise;
        if (cancelled) return;

        const rawContent = await pdfPage.getTextContent();
        if (cancelled) return;
        const content = rawContent as unknown as PdfTextContent;
        contentRef.current = content;
        const textItems = content.items.filter((it): it is PdfTextItem => "str" in it);
        textItemsRef.current = textItems;

        const container = textLayerRef.current;
        if (!container) return;
        container.innerHTML = "";

        const { TextLayer } = await import("pdfjs-dist");
        textLayer = new TextLayer({ textContentSource: rawContent, container, viewport });
        await textLayer.render();
        if (cancelled) return;

        const textDivs = textLayer.textDivs as HTMLElement[];
        textDivsRef.current = textDivs;

        textDivs.forEach((span, i) => {
          const item = textItems[i];
          if (!item) return;
          span.dataset.originalText = item.str;
          span.style.cursor = "text";
          span.addEventListener("click", () => {
            if (activeToolRef.current !== "select") return;
            startEdit(i);
          });
          span.addEventListener("mouseenter", () => {
            if (activeToolRef.current !== "select" || editingIndexRef.current === i) return;
            span.style.outline = "1px dashed #94a3b8";
            span.style.outlineOffset = "1px";
          });
          span.addEventListener("mouseleave", () => {
            if (editingIndexRef.current === i) return;
            span.style.outline = "";
          });
        });

        setReady(true);
      } catch (e: any) {
        // The cleanup below cancels an in-flight render/text-layer task whenever this
        // effect re-runs (e.g. page or zoom change before the previous render finished),
        // which rejects their promises with a cancellation exception — expected, not a bug.
        if (cancelled || e?.name === "RenderingCancelledException") return;
        console.error("PdfPageView render error:", e);
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel?.();
      textLayer?.cancel?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfPage, viewport]);

  // ── Keep span visuals in sync with committed text-edit ops (incl. undo) ──
  useEffect(() => {
    if (!ready) return;
    const textEdits = new Map<number, PdfEditOp & { type: "text-edit" }>();
    for (const op of pageOps) if (op.type === "text-edit") textEdits.set(op.itemIndex, op);

    textDivsRef.current.forEach((span, i) => {
      if (editingIndexRef.current === i) return; // don't clobber an in-progress edit
      const op = textEdits.get(i);
      if (op) {
        span.textContent = op.text;
        span.style.color = "#0f172a";
        span.style.backgroundColor = "#ffffff";
      } else {
        span.textContent = span.dataset.originalText || "";
        span.style.color = "";
        span.style.backgroundColor = "";
      }
    });
  }, [ready, pageOps]);

  // Force-commit an in-progress edit if the user switches tools mid-edit.
  useEffect(() => {
    if (activeTool !== "select" && editingIndexRef.current !== null) {
      textDivsRef.current[editingIndexRef.current]?.blur();
    }
  }, [activeTool]);

  function startEdit(i: number) {
    const span = textDivsRef.current[i];
    const item = textItemsRef.current[i];
    if (!span || !item) return;
    if (editingIndexRef.current !== null) textDivsRef.current[editingIndexRef.current]?.blur();

    editingIndexRef.current = i;
    span.contentEditable = "true";
    span.style.color = "#0f172a";
    span.style.backgroundColor = "#ffffff";
    span.style.outline = "1.5px solid #3b82f6";
    span.style.zIndex = "5";
    // Focusing a contentEditable element synchronously right after setting the
    // attribute is unreliable in some browsers (notably Safari) — it silently
    // no-ops before the DOM has processed the attribute change. Deferring to
    // the next frame makes focus (and the caret) reliable everywhere.
    requestAnimationFrame(() => {
      if (editingIndexRef.current !== i) return; // user already moved on
      span.focus();
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });

    const commit = () => {
      span.removeEventListener("blur", commit);
      span.contentEditable = "false";
      span.style.outline = "";
      span.style.zIndex = "";
      editingIndexRef.current = null;

      const newText = span.textContent || "";
      const original = span.dataset.originalText || "";
      const hasExistingEdit = opsRef.current.some((o) => o.type === "text-edit" && o.page === pageIndex && o.itemIndex === i);
      if (newText === original && !hasExistingEdit) {
        span.style.color = "";
        span.style.backgroundColor = "";
        return;
      }
      if (newText === original) return; // reverted back to original text; leave existing op/undo to remove it

      const fontSize = Math.abs(item.transform[3]) || Math.abs(item.transform[0]) || 12;
      const fontFamily = contentRef.current?.styles?.[item.fontName]?.fontFamily;
      onAddOpRef.current({
        id: crypto.randomUUID(),
        type: "text-edit",
        page: pageIndex,
        itemIndex: i,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height,
        fontSize,
        font: matchStandardFont(fontFamily),
        text: newText,
        color: [0, 0, 0],
      });
    };
    span.addEventListener("blur", commit);
  }

  // ── Interaction layer: highlight drag / freehand draw / textbox & signature placement ──
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const drawPointsRef = useRef<{ x: number; y: number }[]>([]);
  const [livePreview, setLivePreview] = useState<{ kind: "rect" | "path"; rect?: any; points?: { x: number; y: number }[] } | null>(null);
  const [textBoxDraft, setTextBoxDraft] = useState<{ screenX: number; screenY: number; pdfX: number; pdfY: number } | null>(null);
  const [textBoxValue, setTextBoxValue] = useState("");

  const overlayPos = (e: React.PointerEvent) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (activeTool === "highlight") {
      dragRef.current = overlayPos(e);
      setLivePreview({ kind: "rect", rect: { left: dragRef.current.x, top: dragRef.current.y, width: 0, height: 0 } });
    } else if (activeTool === "draw") {
      drawPointsRef.current = [overlayPos(e)];
      setLivePreview({ kind: "path", points: [...drawPointsRef.current] });
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (activeTool === "highlight" && dragRef.current) {
      const cur = overlayPos(e);
      const left = Math.min(dragRef.current.x, cur.x);
      const top = Math.min(dragRef.current.y, cur.y);
      setLivePreview({ kind: "rect", rect: { left, top, width: Math.abs(cur.x - dragRef.current.x), height: Math.abs(cur.y - dragRef.current.y) } });
    } else if (activeTool === "draw" && drawPointsRef.current.length) {
      drawPointsRef.current.push(overlayPos(e));
      setLivePreview({ kind: "path", points: [...drawPointsRef.current] });
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (activeTool === "highlight" && dragRef.current) {
      const start = dragRef.current;
      const end = overlayPos(e);
      dragRef.current = null;
      setLivePreview(null);
      if (Math.abs(end.x - start.x) < 3 && Math.abs(end.y - start.y) < 3) return;
      const [px1, py1] = viewport.convertToPdfPoint(start.x, start.y);
      const [px2, py2] = viewport.convertToPdfPoint(end.x, end.y);
      const op: HighlightOp = {
        id: crypto.randomUUID(), type: "highlight", page: pageIndex,
        x: Math.min(px1, px2), y: Math.min(py1, py2),
        width: Math.abs(px2 - px1), height: Math.abs(py2 - py1),
        color: [1, 0.92, 0.23], opacity: 0.4,
      };
      onAddOp(op);
    } else if (activeTool === "draw" && drawPointsRef.current.length > 1) {
      const pdfPoints = drawPointsRef.current.map((p) => {
        const [px, py] = viewport.convertToPdfPoint(p.x, p.y);
        return { x: px, y: py };
      });
      drawPointsRef.current = [];
      setLivePreview(null);
      const op: DrawOp = { id: crypto.randomUUID(), type: "draw", page: pageIndex, points: pdfPoints, color: [0.9, 0.15, 0.15], strokeWidth: 1.5 };
      onAddOp(op);
    } else if (activeTool === "textbox" && !textBoxDraft) {
      const pos = overlayPos(e);
      const [pdfX, pdfY] = viewport.convertToPdfPoint(pos.x, pos.y);
      setTextBoxDraft({ screenX: pos.x, screenY: pos.y, pdfX, pdfY });
      setTextBoxValue("");
    } else if (activeTool === "signature" && pendingSignature) {
      const pos = overlayPos(e);
      const [pdfX, pdfY] = viewport.convertToPdfPoint(pos.x, pos.y);
      const width = 160, height = 60;
      const op: ImageOp = {
        id: crypto.randomUUID(), type: "image", page: pageIndex,
        x: pdfX, y: pdfY - height / 2, width, height, pngDataUrl: pendingSignature,
      };
      onAddOp(op);
      onPlacementComplete();
    }
  };

  const commitTextBox = () => {
    if (textBoxDraft && textBoxValue.trim()) {
      const fontSize = 12;
      const op: TextBoxOp = {
        id: crypto.randomUUID(), type: "textbox", page: pageIndex,
        x: textBoxDraft.pdfX, y: textBoxDraft.pdfY - fontSize, fontSize,
        font: "Helvetica", text: textBoxValue, color: [0, 0, 0],
      };
      onAddOp(op);
    }
    setTextBoxDraft(null);
    setTextBoxValue("");
    onPlacementComplete();
  };

  return (
    <div
      className="relative bg-white shadow-md"
      style={{ width: viewport.width, height: viewport.height }}
      onClick={() => { if (activeTool === "select") setSelectedOpId(null); }}
    >
      <canvas ref={canvasRef} className="absolute inset-0" />

      {/* Highlights render under the text so glyphs stay legible on top */}
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 1 }}>
        {pageOps.filter((o): o is HighlightOp => o.type === "highlight").map((o) => {
          const r = pdfRectToScreen(viewport, o.x, o.y, o.width, o.height);
          const selected = selectedOpId === o.id;
          return (
            <div
              key={o.id}
              onClick={(e) => { if (activeTool !== "select") return; e.stopPropagation(); setSelectedOpId(o.id); }}
              style={{
                position: "absolute", left: r.left, top: r.top, width: r.width, height: r.height,
                backgroundColor: rgbCss(o.color), opacity: o.opacity,
                pointerEvents: activeTool === "select" ? "auto" : "none",
                cursor: activeTool === "select" ? "pointer" : undefined,
                outline: selected ? "2px solid #3b82f6" : undefined, outlineOffset: 1,
              }}
            >
              <DeleteBadge id={o.id} />
            </div>
          );
        })}
      </div>

      <div ref={textLayerRef} className="textLayer" style={{ zIndex: 2, pointerEvents: activeTool === "select" ? "auto" : "none", ["--total-scale-factor" as any]: scale, ["--scale-factor" as any]: scale }} />

      {/* Text boxes, freehand drawing, and placed signatures render above the text */}
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 3 }}>
        {pageOps.filter((o): o is TextBoxOp => o.type === "textbox").map((o) => {
          const [sx, sy] = viewport.convertToViewportPoint(o.x, o.y);
          const offset = dragOffset?.id === o.id ? dragOffset : null;
          const selected = selectedOpId === o.id;
          return (
            <div
              key={o.id}
              onPointerDown={(e) => beginDrag(o.id, o.x, o.y, e)}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "absolute", left: sx, top: sy - o.fontSize * scale,
                fontSize: o.fontSize * scale, color: rgbCss(o.color), fontFamily: "Helvetica, Arial, sans-serif", whiteSpace: "pre",
                pointerEvents: activeTool === "select" ? "auto" : "none",
                cursor: activeTool === "select" ? "grab" : undefined,
                transform: offset ? `translate(${offset.dx}px, ${offset.dy}px)` : undefined,
                outline: selected ? "1.5px dashed #3b82f6" : undefined, outlineOffset: 3,
              }}
            >
              {o.text}
              <DeleteBadge id={o.id} />
            </div>
          );
        })}
        {pageOps.filter((o): o is ImageOp => o.type === "image").map((o) => {
          const r = pdfRectToScreen(viewport, o.x, o.y, o.width, o.height);
          const offset = dragOffset?.id === o.id ? dragOffset : null;
          const selected = selectedOpId === o.id;
          return (
            <div
              key={o.id}
              onPointerDown={(e) => beginDrag(o.id, o.x, o.y, e)}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "absolute", left: r.left, top: r.top, width: r.width, height: r.height,
                pointerEvents: activeTool === "select" ? "auto" : "none",
                cursor: activeTool === "select" ? "grab" : undefined,
                transform: offset ? `translate(${offset.dx}px, ${offset.dy}px)` : undefined,
                outline: selected ? "1.5px dashed #3b82f6" : undefined, outlineOffset: 3,
              }}
            >
              <img src={o.pngDataUrl} alt="Signature" draggable={false} style={{ width: "100%", height: "100%", pointerEvents: "none" }} />
              <DeleteBadge id={o.id} />
            </div>
          );
        })}
        <svg className="absolute inset-0" width={viewport.width} height={viewport.height}>
          {pageOps.filter((o): o is DrawOp => o.type === "draw").map((o) => {
            const pts = o.points.map((p) => viewport.convertToViewportPoint(p.x, p.y).join(",")).join(" ");
            const selected = selectedOpId === o.id;
            return (
              <g key={o.id}>
                {selected && (
                  <polyline points={pts} fill="none" stroke="#3b82f6" strokeWidth={o.strokeWidth * scale + 4} strokeLinecap="round" strokeLinejoin="round" opacity={0.3} style={{ pointerEvents: "none" }} />
                )}
                <polyline points={pts} fill="none" stroke={rgbCss(o.color)} strokeWidth={o.strokeWidth * scale} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "none" }} />
                {/* Wider invisible stroke so a thin freehand line is easy to click for selection */}
                <polyline
                  points={pts} fill="none" stroke="transparent" strokeWidth={Math.max(14, o.strokeWidth * scale + 10)}
                  strokeLinecap="round" strokeLinejoin="round"
                  style={{ pointerEvents: activeTool === "select" ? "stroke" : "none", cursor: activeTool === "select" ? "pointer" : undefined }}
                  onClick={(e) => { e.stopPropagation(); setSelectedOpId(o.id); }}
                />
              </g>
            );
          })}
          {livePreview?.kind === "path" && (
            <polyline points={livePreview.points!.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="rgb(230,38,38)" strokeWidth={1.5 * scale} strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>
        {selectedOpId && pageOps.filter((o) => o.id === selectedOpId && o.type === "draw").map((o) => {
          const box = opBoundingBox(viewport, o as DrawOp, scale);
          return (
            <div key={`badge-${o.id}`} style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, pointerEvents: "none" }}>
              <DeleteBadge id={o.id} />
            </div>
          );
        })}
      </div>

      {/* Interaction layer for drag/click-based tools */}
      <div
        ref={overlayRef}
        className="absolute inset-0"
        style={{ zIndex: 4, pointerEvents: activeTool === "select" ? "none" : "auto", cursor: activeTool === "select" ? "default" : "crosshair" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {livePreview?.kind === "rect" && (
          <div style={{ position: "absolute", left: livePreview.rect.left, top: livePreview.rect.top, width: livePreview.rect.width, height: livePreview.rect.height, backgroundColor: "rgba(250, 204, 21, 0.4)" }} />
        )}
        {textBoxDraft && (
          <input
            autoFocus
            value={textBoxValue}
            onChange={(e) => setTextBoxValue(e.target.value)}
            onBlur={commitTextBox}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setTextBoxDraft(null); setTextBoxValue(""); onPlacementComplete(); } }}
            style={{ position: "absolute", left: textBoxDraft.screenX, top: textBoxDraft.screenY - 14 * scale, fontSize: 12 * scale, border: "1px solid #3b82f6", background: "white", padding: "1px 3px", minWidth: 120 }}
          />
        )}
      </div>
    </div>
  );
}
