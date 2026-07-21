// lib/config.ts
export const APP_URL = 
  process.env.NEXT_PUBLIC_APP_URL ?? 
  'https://diract.io';

export const GMAIL_REDIRECT_URI = `${APP_URL}/api/gmail/callback`;

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');