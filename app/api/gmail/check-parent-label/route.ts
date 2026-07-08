// app/api/gmail/check-parent-label/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { getUserAccessToken } from "@/lib/gmail/labelManager";

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ conflict: false });

  const { parentLabel } = await req.json();
  const accessToken = await getUserAccessToken(user.id);
  if (!accessToken) return NextResponse.json({ conflict: false });

  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  const labels: { id: string; name: string }[] = data.labels || [];

  // Check if a top-level label with a similar name already exists
  // but with a different spelling/case
  const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '');
  const target = normalise(parentLabel);

  const conflict = labels.find(l => {
    // Only check top-level labels (no slash)
    if (l.name.includes('/')) return false;
    return normalise(l.name) === target && l.name !== parentLabel;
  });

  return NextResponse.json({
    conflict: !!conflict,
    existingName: conflict?.name || null,
  });
}