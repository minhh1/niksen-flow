// components/AppLoader.tsx
"use client";

import { useState, useEffect, type ReactNode } from "react";

export default function AppLoader({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    // 1. Clear stale localStorage cache BEFORE rendering anything
    const CACHE_VERSION = 'v3';
    const stored = localStorage.getItem('nk_app_cache_version');
    if (stored !== CACHE_VERSION) {
      // Wipe everything cache-related
      const toRemove = Object.keys(localStorage).filter(k =>
        k.startsWith('nk_cache_') ||
        k.startsWith('nk_pref_') ||
        k.startsWith('nk_rows_') ||
        k.startsWith('rows_')
      );
      toRemove.forEach(k => localStorage.removeItem(k));
      localStorage.setItem('nk_app_cache_version', CACHE_VERSION);
      console.log(`[AppLoader] Cleared ${toRemove.length} stale cache keys`);
    }

    // 2. Small delay to ensure hydration is complete
    const t1 = setTimeout(() => setFadeOut(true), 400);
    const t2 = setTimeout(() => setReady(true), 800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  if (!ready) {
    return (
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: '#050a30',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          opacity: fadeOut ? 0 : 1,
          transition: 'opacity 0.4s ease-out',
        }}
      >
        <div style={{
          width: 52, height: 52, borderRadius: 16,
          background: '#fff', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          marginBottom: 20,
        }}>
          <svg width="26" height="26" viewBox="0 0 28 28" fill="none">
            <circle cx="14" cy="14" r="10" fill="#050a30"/>
            <path d="M14 8v6l4 2" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h1 style={{
          fontFamily: 'system-ui, sans-serif', fontWeight: 900,
          fontStyle: 'italic', fontSize: 24, letterSpacing: '-0.04em',
          color: '#fff', marginBottom: 28,
        }}>
          Diract
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              width: 7, height: 7, borderRadius: '50%', background: '#6366f1',
              animation: `nkpulse 1.2s ease-in-out ${i * 0.2}s infinite`,
            }} />
          ))}
        </div>
        <style>{`
          @keyframes nkpulse {
            0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
            40% { opacity: 1; transform: scale(1); }
          }
        `}</style>
      </div>
    );
  }

  return <>{children}</>;
}