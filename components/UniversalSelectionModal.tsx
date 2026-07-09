// components/UniversalSelectionModal.tsx
"use client";

import NewProjectModal from "@/components/NewProjectModal";
import NewEntityModal from "@/components/NewEntityModal";
import NewPropertyModal from "@/components/NewPropertyModal";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (...args: any[]) => void;
  title: string;
  table: "entities" | "projects" | "properties" | string;
}

// Thin router — delegates to the correct modal based on table type.
// Custom tables fall through to NewPropertyModal as a generic record creator.
export default function UniversalSelectionModal({ isOpen, onClose, onSelect, table }: Props) {
  const handleRefresh = () => {
    (onSelect as () => void)();
  };

  if (table === 'projects') {
    return <NewProjectModal isOpen={isOpen} onClose={onClose} onRefresh={handleRefresh} />;
  }

  if (table === 'entities') {
    return <NewEntityModal isOpen={isOpen} onClose={onClose} onRefresh={handleRefresh} />;
  }

  if (table === 'properties') {
    return <NewPropertyModal isOpen={isOpen} onClose={onClose} onRefresh={handleRefresh} />;
  }

  // Custom table — generic modal
  return <NewPropertyModal isOpen={isOpen} onClose={onClose} onRefresh={handleRefresh} tableName={table} />;
}
