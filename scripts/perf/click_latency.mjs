// Raw Guacamole-protocol click-latency probe (bypasses the browser
// entirely). Right-clicks a fixed point on the empty desktop -- this
// reliably produces a context-menu redraw every time, unlike clicking
// blank desktop with no visible effect -- and measures wall-clock time from
// the sent mouse instruction to the first resulting "png" screen-update
// instruction. Dismisses the menu with a left-click elsewhere between
// trials. Same methodology used earlier this session on the DO VMs, so
// results are directly comparable.
import { chromium } from "playwright";
import { join } from "path";
import WebSocket from "ws";

const BASE_URL = "http://localhost:3000";
const STORAGE_STATE = join(import.meta.dirname, "auth-state.json");
const VM_ID = process.argv[2];
const LABEL = process.argv[3] || VM_ID;
const TRIALS = 10;
const WIDTH = 1600;
const HEIGHT = 1000;
const CLICK_X = 400;
const CLICK_Y = 300;
const DISMISS_X = 1200;
const DISMISS_Y = 800;

function encode(opcode, ...args) {
  const parts = [`${opcode.length}.${opcode}`, ...args.map((a) => `${String(a).length}.${a}`)];
  return parts.join(",") + ";";
}

async function mintSession() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  const res = await context.request.post(`${BASE_URL}/api/virtual-computers/${VM_ID}/session`, {
    data: { screenWidth: WIDTH, screenHeight: HEIGHT, devicePixelRatio: 1 },
  });
  if (!res.ok()) throw new Error(`session mint failed: ${res.status()} ${await res.text()}`);
  const session = await res.json();
  await browser.close();
  return session;
}

function connect({ authToken, clientIdentifier, guacamoleUrl }) {
  const url = `${guacamoleUrl.replace("https://", "wss://")}/websocket-tunnel?token=${authToken}&GUAC_DATA_SOURCE=json&GUAC_ID=${clientIdentifier}&GUAC_TYPE=c&GUAC_WIDTH=${WIDTH}&GUAC_HEIGHT=${HEIGHT}&GUAC_DPI=96&GUAC_AUDIO=&GUAC_VIDEO=&GUAC_IMAGE=image%2Fpng`;
  return new WebSocket(url);
}

async function waitForFirstSync(ws, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for initial sync")), timeoutMs);
    const onMessage = (data) => {
      const s = data.toString();
      if (s.includes("5.error")) {
        clearTimeout(timeout);
        ws.off("message", onMessage);
        reject(new Error(`server error: ${s.slice(0, 200)}`));
      } else if (s.includes("4.sync,")) {
        clearTimeout(timeout);
        ws.off("message", onMessage);
        resolve();
      }
    };
    ws.on("message", onMessage);
  });
}

function waitForNextPng(ws, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = performance.now();
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      resolve(null);
    }, timeoutMs);
    const onMessage = (data) => {
      const s = data.toString();
      if (s.includes("3.png,")) {
        clearTimeout(timeout);
        ws.off("message", onMessage);
        resolve(performance.now() - start);
      }
    };
    ws.on("message", onMessage);
  });
}

async function main() {
  const session = await mintSession();
  const ws = connect(session);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  await waitForFirstSync(ws);
  console.log(`${LABEL}: connected, running ${TRIALS} right-click trials...`);

  const results = [];
  for (let i = 0; i < TRIALS; i++) {
    ws.send(encode("mouse", CLICK_X, CLICK_Y, "0"));
    await new Promise((r) => setTimeout(r, 50));

    const pngPromise = waitForNextPng(ws);
    ws.send(encode("mouse", CLICK_X, CLICK_Y, "4"));
    await new Promise((r) => setTimeout(r, 30));
    ws.send(encode("mouse", CLICK_X, CLICK_Y, "0"));
    const latency = await pngPromise;
    results.push(latency);
    console.log(`  trial ${i + 1}: ${latency === null ? "TIMEOUT (>5000ms)" : latency.toFixed(0) + "ms"}`);

    // Dismiss the context menu before the next trial.
    ws.send(encode("mouse", DISMISS_X, DISMISS_Y, "0"));
    await new Promise((r) => setTimeout(r, 30));
    ws.send(encode("mouse", DISMISS_X, DISMISS_Y, "1"));
    await new Promise((r) => setTimeout(r, 30));
    ws.send(encode("mouse", DISMISS_X, DISMISS_Y, "0"));
    await new Promise((r) => setTimeout(r, 500));
  }

  const valid = results.filter((r) => r !== null);
  const timeouts = results.length - valid.length;
  valid.sort((a, b) => a - b);
  const median = valid.length ? valid[Math.floor(valid.length / 2)] : null;
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  console.log(
    `${LABEL}: median=${median?.toFixed(0)}ms mean=${mean?.toFixed(0)}ms min=${valid[0]?.toFixed(0)}ms max=${valid[valid.length - 1]?.toFixed(0)}ms timeouts=${timeouts}/${TRIALS}`
  );

  ws.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
