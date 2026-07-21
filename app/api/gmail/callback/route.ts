import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { APP_URL, GMAIL_REDIRECT_URI } from "@/lib/config";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');

  if (error) {
    console.error('Google OAuth error:', error);
    return NextResponse.redirect(
      `${APP_URL}/dashboard/gmail?error=` + error
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${APP_URL}/dashboard/gmail?error=no_code`
    );
  }

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: GMAIL_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenRes.json();
  console.log('Token exchange result:', {
    hasAccessToken: !!tokens.access_token,
    hasRefreshToken: !!tokens.refresh_token,
    error: tokens.error,
  });

  if (tokens.error) {
    return NextResponse.redirect(
      `${APP_URL}/dashboard/gmail?error=` + tokens.error
    );
  }

  // Get Gmail address
  const profileRes = await fetch(
    'https://www.googleapis.com/oauth2/v1/userinfo',
    { headers: { Authorization: `Bearer ${tokens.access_token}` } }
  );
  const profile = await profileRes.json();
  console.log('Google profile email:', profile.email);

  // Create Supabase client
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Ignore cookie errors in route handlers
          }
        },
      },
    }
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  console.log('Auth user:', user?.id, 'error:', authError?.message);

  if (!user) {
    // User not logged in — store tokens in URL params temporarily
    // and redirect to login with a return URL
    return NextResponse.redirect(
      `${APP_URL}/login?redirect=/dashboard/gmail`
    );
  }

  const { data: prof } = await supabase
    .from('profiles')
    .select('active_company_id')
    .eq('id', user.id)
    .single();

  const { error: upsertError } = await supabase
    .from('user_gmail_tokens')
    .upsert({
      user_id: user.id,
      company_id: prof?.active_company_id,
      email: profile.email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: new Date(
        Date.now() + (tokens.expires_in || 3600) * 1000
      ).toISOString(),
    }, { onConflict: 'user_id' });

  if (upsertError) {
    console.error('Token upsert error:', upsertError);
    return NextResponse.redirect(
      `${APP_URL}/dashboard/gmail?error=${error}`
    );
  }

  return NextResponse.redirect(
    `${APP_URL}/dashboard/gmail?connected=true`
  );
}