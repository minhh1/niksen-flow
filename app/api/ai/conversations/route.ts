// app/api/ai/conversations/route.ts
// Lists the current user's AI assistant conversation threads (personal,
// not shared with teammates -- see supabase/ai_conversations.sql). No
// stored title -- derives a display label from each thread's first user
// message instead.
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";

export async function GET() {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin } = auth;

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: conversations, error } = await admin
    .from("ai_conversations")
    .select("id, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!conversations || conversations.length === 0) return NextResponse.json({ conversations: [] });

  const { data: firstMessages } = await admin
    .from("ai_messages")
    .select("conversation_id, content, created_at")
    .in("conversation_id", conversations.map((c) => c.id))
    .eq("role", "user")
    .order("created_at", { ascending: true });

  const titleByConversation = new Map<string, string>();
  for (const m of firstMessages ?? []) {
    if (!titleByConversation.has(m.conversation_id)) titleByConversation.set(m.conversation_id, m.content);
  }

  return NextResponse.json({
    conversations: conversations.map((c) => ({
      id: c.id,
      updatedAt: c.updated_at,
      title: (titleByConversation.get(c.id) ?? "New chat").slice(0, 60),
    })),
  });
}
