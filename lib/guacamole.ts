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
import type { FlyRegion } from "./vmProviders/regions";

const TOKEN_TTL_MS = 5 * 60 * 1000; // only needs to live long enough for the browser to open the client iframe

// One guacd+guacamole app-pair per Fly region (see guacamole/README.md) --
// each region's URL is its own env var since there's no way to derive one
// from another (different Fly app hostnames). GUACAMOLE_URL alone remains
// the local-dev / single-region fallback for any region without its own
// var set, so a fresh checkout or a region added to regions.ts before its
// gateway is deployed doesn't hard-fail.
const REGION_URL_ENV: Record<FlyRegion, string> = {
  syd: "GUACAMOLE_URL_SYD",
  iad: "GUACAMOLE_URL_IAD",
  fra: "GUACAMOLE_URL_FRA",
  sin: "GUACAMOLE_URL_SIN",
};

export function resolveGuacamoleUrl(flyRegion: FlyRegion): string {
  return (
    process.env[REGION_URL_ENV[flyRegion]] ||
    process.env.GUACAMOLE_URL ||
    "http://localhost:8080/guacamole"
  );
}

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
  // Base URL of the gateway to mint the token against -- resolve with
  // resolveGuacamoleUrl(resolveFlyRegion(vm.provider, vm.region)) so the
  // token is minted on (and later served from) whichever region's guacd is
  // actually closest to this VM.
  guacamoleUrl: string;
  // Display size in pixels. Both required together -- callers resolve
  // "auto" (null stored resolution) to the connecting browser's own
  // screen size before calling this, so this function never has to guess.
  // Both should already be scaled by the connecting device's
  // devicePixelRatio (see GuacamoleViewer.tsx) -- otherwise a HiDPI
  // display renders the remote desktop at less than its native pixel
  // density and the browser stretches it to fit, which looks blurry.
  width: number;
  height: number;
  dpi: number;
}

export interface GuacamoleSession {
  authToken: string;
  // Base64 "<connection>\0c\0json" identifier the web client expects in its
  // #/client/<id> route -- see guacamole/README.md.
  clientIdentifier: string;
}

export async function getGuacamoleSession(params: GuacamoleConnectionParams): Promise<GuacamoleSession> {
  const { connectionLabel, protocol, hostname, username, password, width, height, dpi, guacamoleUrl } = params;
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
          dpi: String(dpi),
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
          //
          // enable-font-smoothing defaults to false in Guacamole (RDP itself
          // renders text with rough edges by default, to cut the color
          // count/bandwidth text needs) -- simply not setting it to "false"
          // still leaves it off. That's the actual cause of a second,
          // narrower blur regression seen after the devicePixelRatio/DPI fix
          // below: native GDI-rendered shell UI (File Explorer) looked fine,
          // but anti-aliased page content inside Chrome was still visibly
          // rough -- exactly Guacamole's documented default behavior, not a
          // leftover from the color-depth/font-smoothing settings already
          // reverted above. Needs to be explicitly turned on.
          ...(protocol === "rdp"
            ? {
                "ignore-cert": "true",
                "enable-wallpaper": "false",
                "enable-menu-animations": "false",
                "enable-font-smoothing": "true",
              }
            : {}),
        },
      },
    },
  };

  const data = buildTokenData(payload);

  let res: Response;
  try {
    res = await fetch(`${guacamoleUrl}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data }),
    });
  } catch {
    throw new Error(`Could not reach the Guacamole gateway at ${guacamoleUrl}. Is it running? (see guacamole/README.md)`);
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
