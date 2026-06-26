import { supabase } from "@/lib/supabase";

export type LogParentType = 'property' | 'entity' | 'project';

interface LogActivityParams {
  parentType: LogParentType;
  parentId: string;
  companyId: string;
  action: string;
  details?: Record<string, any>;
}

const PARENT_ID_COLUMN: Record<LogParentType, string> = {
  property: 'property_id',
  entity: 'entity_id',
  project: 'project_id',
};

export async function logActivity({ parentType, parentId, companyId, action, details }: LogActivityParams) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("audit_logs").insert([{
    company_id: companyId,
    user_id: user?.id,
    [PARENT_ID_COLUMN[parentType]]: parentId,
    action,
    details: details || {},
  }]);
  if (error) console.error('logActivity error:', error);
}