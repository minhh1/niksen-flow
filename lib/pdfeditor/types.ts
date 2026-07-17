// Shared types for the PDF editor's edit-op log. All geometry is in PDF user-space
// points (origin bottom-left, y-up) — the same space pdf.js text items already use
// (item.transform/item.width) and the space pdf-lib's page.draw* methods expect.
// Screen/canvas pixel coordinates are converted to/from this space via the page's
// pdf.js viewport (convertToPdfPoint / convertToViewportPoint), never hand-rolled.

export type StandardFontKey =
  | "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique" | "Helvetica-BoldOblique"
  | "TimesRoman" | "Times-Bold" | "Times-Italic" | "Times-BoldItalic"
  | "Courier" | "Courier-Bold" | "Courier-Oblique" | "Courier-BoldOblique";

export type RGB = [number, number, number]; // 0-1 range, as pdf-lib's rgb() expects

export interface TextEditOp {
  id: string;
  type: "text-edit";
  page: number; // 0-indexed
  itemIndex: number; // index into that page's getTextContent() text items, for re-matching on re-render
  x: number;
  y: number; // baseline, PDF space
  width: number; // original run's width, used for the whiteout box
  height: number; // approx cap height, used for the whiteout box
  fontSize: number;
  font: StandardFontKey;
  text: string;
  color: RGB;
}

export interface HighlightOp {
  id: string;
  type: "highlight";
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: RGB;
  opacity: number;
}

export interface TextBoxOp {
  id: string;
  type: "textbox";
  page: number;
  x: number;
  y: number;
  fontSize: number;
  font: StandardFontKey; // encodes bold/italic — see fontMatch.ts's withBoldItalic/isBoldFont/isItalicFont
  underline: boolean; // pdf-lib has no text-decoration; drawn as a manual line at save time
  text: string;
  color: RGB;
}

export interface DrawOp {
  id: string;
  type: "draw";
  page: number;
  points: { x: number; y: number }[]; // PDF space, polyline
  color: RGB;
  strokeWidth: number;
}

export interface ImageOp {
  id: string;
  type: "image";
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pngDataUrl: string; // signature/stamp, drawn client-side
}

export type PdfEditOp = TextEditOp | HighlightOp | TextBoxOp | DrawOp | ImageOp;

export type ToolId = "select" | "edit-text" | "textbox" | "highlight" | "draw" | "signature";
