// app/api/gmail/auth/route.ts
// Redirects user to Google OAuth consent screen
import { NextResponse } from "next/server";
import { GMAIL_REDIRECT_URI, GMAIL_SCOPES } from "@/lib/config";

export async function GET() {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: GMAIL_REDIRECT_URI,
    response_type: 'code',
    scope: GMAIL_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });
  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  );
}