// app/api/gmail/check-label/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { getUserAccessToken } from "@/lib/gmail/labelManager";

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { messageId, threadId, proposedLabel, parentLabel } = await req.json();

  const accessToken = await getUserAccessToken(user.id);
  if (!accessToken) return NextResponse.json({ conflict: false });

  // Get message details to check its current labels
  const msgRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const msgData = await msgRes.json();
  const currentLabelIds: string[] = msgData.labelIds || [];

  // Get all user's labels to resolve IDs to names
  const labelsRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const labelsData = await labelsRes.json();
  const allLabels: { id: string; name: string }[] = labelsData.labels || [];

  // Find any labels on this message that start with our parent prefix
  const conflictingLabels = currentLabelIds
    .map(id => allLabels.find(l => l.id === id))
    .filter((l): l is { id: string; name: string } =>
      !!l && l.name.startsWith(`${parentLabel}/`) && l.name !== proposedLabel
    );

  // Also check other messages in the same thread
  let threadConflicts: string[] = [];
  if (threadId) {
    const threadRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const threadData = await threadRes.json();
    const threadLabelIds = new Set<string>();
    (threadData.messages || []).forEach((m: any) => {
      (m.labelIds || []).forEach((id: string) => threadLabelIds.add(id));
    });

    threadConflicts = [...threadLabelIds]
      .map(id => allLabels.find(l => l.id === id))
      .filter((l): l is { id: string; name: string } =>
        !!l && l.name.startsWith(`${parentLabel}/`) && l.name !== proposedLabel
      )
      .map(l => l.name);
  }

  // Also check our DB — is this message already assigned to a different project?
  const { data: existing } = await supabase
    .from('project_emails')
    .select('project_id, project:project_id(name)')
    .eq('gmail_message_id', messageId)
    .eq('user_id', user.id)
    .single();

  const dbConflict = existing?.project_id ? {
    projectId: existing.project_id,
    projectName: (existing as any).project?.name || 'Unknown project',
  } : null;

  return NextResponse.json({
    conflict: conflictingLabels.length > 0 || threadConflicts.length > 0 || !!dbConflict,
    existingLabels: conflictingLabels.map(l => l.name),
    threadLabels: [...new Set(threadConflicts)],
    dbConflict,
  });
}