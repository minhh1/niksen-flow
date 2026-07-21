// lib/msTeamsBot/verifyIncomingToken.ts
// Validates that an inbound request to app/api/teams/bot/[companyId]
// genuinely came from the Bot Framework Connector service (or the Bot
// Framework Emulator, for local testing), per Microsoft's own
// "Authenticate requests with the Bot Connector API" doc (verified
// 2026-07-21) -- plain JWT/OpenID over HTTPS, no Bot Framework SDK
// required. Getting every one of these checks right matters: skipping any
// of them lets an attacker read messages sent to the bot, send messages
// impersonating it, or otherwise fully spoof the Connector.
//
// Two issuers are accepted:
//   - Real Connector traffic: iss "https://api.botframework.com", keys from
//     the static https://login.botframework.com/v1/.well-known/keys.
//   - Bot Framework Emulator (local dev only): iss is one of a small fixed
//     set of botframework.com tenant issuer strings Microsoft documents,
//     keys from login.microsoftonline.com's common JWKS, and the token
//     must also carry the bot's own App ID in `appid` (v1) or `azp` (v2).
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

const CONNECTOR_ISSUER = "https://api.botframework.com";
const CONNECTOR_JWKS = createRemoteJWKSet(new URL("https://login.botframework.com/v1/.well-known/keys"));

const EMULATOR_ISSUERS = new Set([
  "https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/",
  "https://login.microsoftonline.com/d6d49420-f39b-4df7-a1dc-d59a935871db/v2.0",
  "https://sts.windows.net/f8cdef31-a31e-4b4a-93e4-5f571e91255a/",
  "https://login.microsoftonline.com/f8cdef31-a31e-4b4a-93e4-5f571e91255a/v2.0",
]);
const EMULATOR_JWKS = createRemoteJWKSet(new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"));

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export async function verifyIncomingBotRequest(
  authHeader: string | null,
  expectedBotAppId: string,
  serviceUrlFromBody: string
): Promise<VerifyResult> {
  if (!authHeader?.startsWith("Bearer ")) return { ok: false, reason: "Missing bearer token" };
  const token = authHeader.slice("Bearer ".length);

  let unverifiedIssuer: unknown;
  try {
    unverifiedIssuer = decodeJwt(token).iss;
  } catch {
    return { ok: false, reason: "Malformed JWT" };
  }
  const isEmulator = typeof unverifiedIssuer === "string" && EMULATOR_ISSUERS.has(unverifiedIssuer);

  try {
    if (isEmulator) {
      const { payload } = await jwtVerify(token, EMULATOR_JWKS, {
        audience: expectedBotAppId,
        algorithms: ["RS256"],
        clockTolerance: "5 minutes",
      });
      const appIdClaim = (payload as Record<string, unknown>).appid ?? payload.azp;
      if (appIdClaim !== expectedBotAppId) return { ok: false, reason: "App ID mismatch (emulator)" };
    } else {
      const { payload } = await jwtVerify(token, CONNECTOR_JWKS, {
        issuer: CONNECTOR_ISSUER,
        audience: expectedBotAppId,
        algorithms: ["RS256"],
        clockTolerance: "5 minutes",
      });
      const serviceUrlClaim = (payload as Record<string, unknown>).serviceUrl;
      if (serviceUrlClaim && serviceUrlClaim !== serviceUrlFromBody) {
        return { ok: false, reason: "serviceUrl claim does not match request body" };
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
