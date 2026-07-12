// components/QueryProvider.tsx
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export default function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,        // data stays fresh for 30s — no refetch within this window
        gcTime: 5 * 60 * 1000,       // keep unused cache for 5 min
        refetchOnWindowFocus: true,  // refetch when user switches back to tab
        refetchOnReconnect: true,    // refetch when network reconnects
        retry: 1,
      },
    },
  }));

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}