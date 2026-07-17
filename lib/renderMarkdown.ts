// lib/renderMarkdown.ts
// Renders admin-authored text (currently just a document template's client-
// facing "explanation") as basic formatted HTML — bold/italic/lists/links —
// sanitized before use with dangerouslySetInnerHTML. isomorphic-dompurify
// (not plain dompurify) because this runs inside a "use client" component
// that Next still server-renders once for the initial HTML, where there's
// no `window` for plain DOMPurify to attach to.
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

marked.setOptions({ breaks: true });

const ALLOWED_TAGS = ["p", "br", "strong", "em", "b", "i", "u", "ul", "ol", "li", "a", "h1", "h2", "h3", "blockquote", "code", "pre"];
const ALLOWED_ATTR = ["href", "target", "rel"];

export function renderMarkdown(text: string | null | undefined): string {
  if (!text) return "";
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
}
