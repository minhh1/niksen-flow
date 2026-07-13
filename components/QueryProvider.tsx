// components/QueryProvider.tsx
"use client";
import { useEffect } from "react";
import { clearStaleCrossCompanyCache } from "@/lib/queryCache";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export default function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
        gcTime: 5 * 60 * 1000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: 1,
      },
    },
  }));

  useEffect(() => {
    // Clear old non-company-scoped cache keys on startup
    clearStaleCrossCompanyCache();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}