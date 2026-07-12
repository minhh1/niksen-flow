// lib/hooks/useTableRows.ts
// Shared TanStack Query hook for fetching table rows.
// Used by both Sidebar and GenericMasterTable — requests are automatically
// deduplicated so only ONE DB fetch happens regardless of how many components use it.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

type TableName = 'projects' | 'properties' | 'entities';

const NAME_COL: Record<TableName, string> = {
  projects:   'name',
  properties: 'street_address',
  entities:   'name',
};

// Shared fetcher — fetches id + name column only (for sidebar)
// GenericMasterTable overrides with its own richer select
async function fetchRows(tableName: TableName): Promise<any[]> {
  const nameCol = NAME_COL[tableName];
  const { data, error } = await supabase
    .from(tableName)
    .select(`id, ${nameCol}`)
    .is('deleted_at', null)
    .order(nameCol)
    .limit(200);

  if (error) {
    console.error(`[useTableRows] ${tableName}:`, error.message);
    throw error;
  }
  return data || [];
}

// Hook for sidebar — lightweight, just id + name
export function useTableRows(tableName: TableName) {
  return useQuery({
    queryKey: ['rows', tableName],
    queryFn: () => fetchRows(tableName),
    staleTime: 30 * 1000,
  });
}

// Hook for master table — accepts a custom fetcher for richer selects
// but shares the same query key so sidebar benefits from the cache
export function useTableRowsFull(
  tableName: TableName,
  fetcher: () => Promise<any[]>,
  enabled = true,
) {
  return useQuery({
    queryKey: ['rows', tableName],
    queryFn: fetcher,
    enabled,
    staleTime: 30 * 1000,
  });
}

// Invalidate rows cache — call after insert/update/delete
export function useInvalidateRows() {
  const queryClient = useQueryClient();
  return (tableName: TableName) => {
    queryClient.invalidateQueries({ queryKey: ['rows', tableName] });
  };
}