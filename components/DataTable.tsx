// components/DataTable.tsx
"use client";

import React from "react";

interface DataTableProps {
  children: React.ReactNode;
  minWidth?: number;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  className?: string;
}

export default function DataTable({
  children,
  minWidth = 1200,
  scrollRef,
  onScroll,
  className = "",
}: DataTableProps) {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={`flex-1 overflow-auto min-h-0 custom-scrollbar ${className}`}
    >
      <div
        className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden inline-block min-w-full"
        style={{ minWidth: `${minWidth}px` }}
      >
        <table className="w-full table-fixed border-collapse text-left text-[13px]">
          {children}
        </table>
      </div>
    </div>
  );
}