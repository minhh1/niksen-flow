// app/api/gmail/messages/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { fetchEmails } from "@/lib/gmail/client";

export async function GET(req: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      console.error('Auth error:', authError?.message);
      return NextResponse.json({ error: 'Unauthorized', messages: [] }, { status: 401 });
    }

    // Check token exists
    const { data: tokenRow, error: tokenError } = await supabase
      .from('user_gmail_tokens')
      .select('email, token_expires_at')
      .eq('user_id', user.id)
      .single();

    if (tokenError || !tokenRow) {
      console.error('Token fetch error:', tokenError?.message);
      return NextResponse.json({ error: 'Gmail not connected', messages: [] }, { status: 400 });
    }

    console.log('Fetching emails for:', tokenRow.email);

    const query = req.nextUrl.searchParams.get('q') || 'in:inbox';
    const messages = await fetchEmails(user.id, supabase, query);

    console.log('Fetched', messages.length, 'messages');

    return NextResponse.json({ messages });
  } catch (err: any) {
    console.error('Gmail messages error:', err?.message || err);
    return NextResponse.json({ error: err?.message, messages: [] }, { status: 500 });
  }
}