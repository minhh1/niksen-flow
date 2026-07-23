// lib/whatsappBot/verifySignature.ts
// Verifies Meta's per-request webhook authenticity header -- confirmed
// against developers.facebook.com/docs/graph-api/webhooks/getting-started
// (2026-07-24): X-Hub-Signature-256, formatted "sha256={hex digest}", is an
// HMAC-SHA256 of the *raw* request body using the Meta App's App Secret (a
// different secret than the access_token or webhook_verify_token already
// stored in company_whatsapp_credentials -- found in the Meta App
// dashboard's Basic settings). Must be computed over the exact bytes Meta
// sent, so callers need to read the body as text before JSON.parse-ing it
// (see app/api/whatsapp/webhook/[companyId]/route.ts).
import { createHmac, timingSafeEqual } from "crypto";

export function verifyWhatsAppSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader || !appSecret) return false;
  const [scheme, provided] = signatureHeader.split("=");
  if (scheme !== "sha256" || !provided) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
