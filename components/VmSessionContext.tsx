// components/VmSessionContext.tsx
// Tracks whether the user is currently "inside" a virtual computer session
// (app/dashboard/virtual-computers/[id]/page.tsx sets this on mount, clears
// it on an explicit log off). Sidebar.tsx consumes this to block navigation
// elsewhere in the app while it's active -- see the plan's disconnect-
// detection design: leaving the VM session page is the primary, explicit
// signal that a user is done, so navigation away has to go through that
// page's own log-off action rather than silently succeeding.
"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

interface VmSessionContextValue {
  active: boolean;
  setActive: (active: boolean) => void;
}

const VmSessionContext = createContext<VmSessionContextValue>({ active: false, setActive: () => {} });

export function VmSessionProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  return <VmSessionContext.Provider value={{ active, setActive }}>{children}</VmSessionContext.Provider>;
}

export function useVmSession() {
  return useContext(VmSessionContext);
}
