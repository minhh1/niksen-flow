// lib/guacamole.ts
// Mints Apache Guacamole session tokens via the JSON auth extension (see
// guacamole/README.md) -- no Guacamole user database needed. Payload
// encoding follows Guacamole's documented json-auth format exactly
// (https://guacamole.apache.org/doc/gug/json-auth.html): HMAC-SHA256 sign
// the JSON payload, prepend the signature, AES-128-CBC encrypt the result
// with an all-zero IV (per spec -- not random, and not stored in the
// output), base64 encode. Fetch handling mirrors the style in
// lib/gotenberg.ts (try/catch, res.ok check, truncated error body).
import crypto from "crypto";
import type { VmProtocol } from "./vmProviders/types";

const GUACAMOLE_URL = process.env.GUACAMOLE_URL || "http://localhost:8080/guacamole";
const TOKEN_TTL_MS = 5 * 60 * 1000; // only needs to live long enough for the browser to open the client iframe

function secretKey(): Buffer {
  const hex = process.env.GUACAMOLE_JSON_SECRET_KEY;
  if (!hex) throw new Error("GUACAMOLE_JSON_SECRET_KEY is not set.");
  const key = Buffer.from(hex, "hex");
  if (key.length !== 16) {
    throw new Error("GUACAMOLE_JSON_SECRET_KEY must be a 32-character hex string (16 bytes) -- generate with `openssl rand -hex 16`.");
  }
  return key;
}

function buildTokenData(payload: object): string {
  const key = secretKey();
  const json = Buffer.from(JSON.stringify(payload), "utf8");

  const signature = crypto.createHmac("sha256", key).update(json).digest();
  const signed = Buffer.concat([signature, json]);

  // Per spec, the IV is fixed at all-zero bytes and is not itself part of
  // the transmitted token -- only the ciphertext is base64-encoded.
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(signed), cipher.final()]);

  return encrypted.toString("base64");
}

export interface GuacamoleConnectionParams {
  connectionLabel: string;
  protocol: VmProtocol;
  hostname: string;
  username: string;
  password: string;
  // Display size in pixels. Both required together -- callers resolve
  // "auto" (null stored resolution) to the connecting browser's own
  // screen size before calling this, so this function never has to guess.
  width: number;
  height: number;
}

export interface GuacamoleSession {
  authToken: string;
  // Base64 "<connection>\0c\0json" identifier the web client expects in its
  // #/client/<id> route -- see guacamole/README.md.
  clientIdentifier: string;
}

export async function getGuacamoleSession(params: GuacamoleConnectionParams): Promise<GuacamoleSession> {
  const { connectionLabel, protocol, hostname, username, password, width, height } = params;
  const port = protocol === "vnc" ? "5901" : "3389";

  const payload = {
    username: `vc-${connectionLabel}`,
    expires: Date.now() + TOKEN_TTL_MS,
    connections: {
      [connectionLabel]: {
        protocol,
        parameters: {
          hostname,
          port,
          username,
          password,
          width: String(width),
          height: String(height),
          dpi: "96",
          // Lets an already-open session adapt if the browser window
          // resizes, instead of requiring a full reconnect to change size.
          "resize-method": "display-update",
          // Only disable toggles that are purely decorative/behavioral --
          // wallpaper and menu/drag animations -- not anything that touches
          // how text or color actually renders. An earlier version of this
          // also set color-depth to 16 and turned off font-smoothing and
          // desktop-composition for bandwidth; in practice that made real
          // application content (anti-aliased text, gradients) visibly
          // blurry -- confirmed directly (Gmail in a VM session: taskbar/
          // icons were fine, but on-screen text wasn't rendering cleanly).
          // Reduced color depth causes banding on anti-aliased edges, and
          // disabling font-smoothing directly disables ClearType -- neither
          // is worth the bandwidth savings. VNC has no equivalent toggle set
          // (raw framebuffer protocol), so nothing extra applies there.
          ...(protocol === "rdp"
            ? {
                "ignore-cert": "true",
                "enable-wallpaper": "false",
                "enable-menu-animations": "false",
              }
            : {}),
        },
      },
    },
  };

  const data = buildTokenData(payload);

  let res: Response;
  try {
    res = await fetch(`${GUACAMOLE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data }),
    });
  } catch {
    throw new Error(`Could not reach the Guacamole gateway at ${GUACAMOLE_URL}. Is it running? (see guacamole/README.md)`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Guacamole token request failed (${res.status}): ${text.slice(0, 200) || "unknown error"}`);
  }

  const body = await res.json();
  if (!body.authToken) throw new Error("Guacamole token response did not include an authToken.");

  const clientIdentifier = Buffer.from(`${connectionLabel}\0c\0json`).toString("base64");
  return { authToken: body.authToken as string, clientIdentifier };
}
