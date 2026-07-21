// app/api/gmail/debug/route.ts
import { NextRequest, NextResponse } from "next/server";
import { GMAIL_REDIRECT_URI } from "@/lib/config";

export async function GET(req: NextRequest) {
  const redirectUri = GMAIL_REDIRECT_URI;

  const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.labels',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email',
  ].join(' ');

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || 'NOT_SET',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });

  const fullUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  return NextResponse.json({
    redirect_uri_being_sent: redirectUri,
    google_client_id_set: !!process.env.GOOGLE_CLIENT_ID,
    full_oauth_url: fullUrl,
  });
}