import { Suspense } from "react";
import Sidebar from "@/components/Sidebar";
import QueryProvider from "@/components/QueryProvider";
import { CompanyProvider } from "@/components/CompanyContext";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <CompanyProvider>
        <div className="flex h-screen w-full bg-slate-50 overflow-hidden font-sans antialiased text-slate-900">
          {/* COLUMN 1: Sidebar — Sidebar itself controls width so it can collapse */}
          <aside className="flex-shrink-0">
            <Suspense fallback={<div className="w-72 p-10 animate-pulse bg-slate-50 h-full" />}>
              <Sidebar />
            </Suspense>
          </aside>

          {/* COLUMN 2: Content Area */}
          <main className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto">
              {children}
            </div>
          </main>
        </div>
      </CompanyProvider>
    </QueryProvider>
  );
}
