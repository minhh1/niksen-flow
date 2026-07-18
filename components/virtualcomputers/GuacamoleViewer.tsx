// components/virtualcomputers/GuacamoleViewer.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Maximize2, Minimize2 } from "lucide-react";

const GUACAMOLE_URL = process.env.NEXT_PUBLIC_GUACAMOLE_URL || "http://localhost:8080/guacamole";

export default function GuacamoleViewer({ vmId }: { vmId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      containerRef.current?.requestFullscreen();
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/virtual-computers/${vmId}/session`, { method: "POST" });
      const json = await res.json();
      if (cancelled) return;
      if (!res.ok) {
        setError(json.error || "Could not start session");
        return;
      }
      // This Guacamole deployment runs Angular in hashbang mode
      // (html5Mode(false)), so $location.search() -- which is what reads
      // the auto-login `token` param -- parses the query string INSIDE the
      // hash fragment, not window.location.search. token must come after
      // the `#/client/...` route, not before it (confirmed by inspecting
      // the deployed app's own bundle, not guessed).
      setSrc(`${GUACAMOLE_URL}/#/client/${json.clientIdentifier}?token=${json.authToken}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [vmId]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-[13px] text-red-600 bg-red-50 m-6 rounded-2xl p-6">
        {error}
      </div>
    );
  }

  if (!src) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-[13px] text-slate-400">
        <Loader2 size={16} className="animate-spin" /> Connecting...
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full h-full bg-black">
      <iframe
        src={src}
        className="w-full h-full border-0"
        // No sandbox: Guacamole needs to be able to take real keyboard focus
        // on click (its remote-input capture relies on focusing a hidden
        // textarea) -- sandboxing this iframe left focus stuck on <body>,
        // so mouse input reached the VM but keystrokes never did. This is
        // our own trusted backend, not third-party content, so sandboxing
        // it isn't buying any real isolation anyway.
        allow="clipboard-read; clipboard-write; fullscreen"
        title="Virtual computer session"
      />
      <button
        onClick={toggleFullscreen}
        title={isFullscreen ? "Exit full screen" : "Enter full screen"}
        className="absolute top-3 right-3 p-2 rounded-lg bg-black/50 hover:bg-black/70 text-white transition-colors"
      >
        {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
    </div>
  );
}
