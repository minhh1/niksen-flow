// app/dashboard/layout.tsx
import { Suspense } from "react";
import Sidebar from "@/components/Sidebar";
import QueryProvider from "@/components/QueryProvider";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <div className="flex h-screen w-full bg-slate-50 overflow-hidden font-sans antialiased text-slate-900">
        <aside className="w-72 flex-shrink-0 border-r border-slate-200 bg-white">
          <Suspense fallback={<div className="p-10 animate-pulse bg-slate-50 h-full" />}>
            <Sidebar />
          </Suspense>
        </aside>
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            {children}
          </div>
        </main>
      </div>
    </QueryProvider>
  );
}