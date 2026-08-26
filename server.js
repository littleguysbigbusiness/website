'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

/* ------------------------------------------------------------------ config */

const PORT = Number(process.env.PORT) || 3000;
const VIEWPORT_WIDTH = Number(process.env.VIEWPORT_WIDTH) || 1280;
const VIEWPORT_HEIGHT = Number(process.env.VIEWPORT_HEIGHT) || 720;
const FRAME_QUALITY = Number(process.env.FRAME_QUALITY) || 60;   // 1-100 jpeg
const EVERY_NTH_FRAME = Number(process.env.EVERY_NTH_FRAME) || 1; // 2 = half rate
const IDLE_REFRESH_MS = Number(process.env.IDLE_REFRESH_MS) || 2000;
const START_URL = process.env.START_URL || 'https://example.com';
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024; // drop frames for clients this far behind
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 5; // one headless page per visitor — cap it

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------- state */

let browser = null;
// Every connected visitor gets their own Puppeteer page + CDP session, so two
// people on the site no longer drive the same tab.
const sessions = new Map(); // ws -> { page, cdp, lastFrameAt }

// The legacy stateless /navigate, /click, /type routes have no notion of
// "which visitor" — they share one dedicated session, created on first use.
let restSession = null;

/* ------------------------------------------------------------- http server */

const app = express();
app.use(express.json());

const INDEX_CANDIDATES = [
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'index.html'),
];

app.get('/', (req, res) => {
  const file = INDEX_CANDIDATES.find((p) => fs.existsSync(p));
  if (!file) return res.status(404).send('index.html not found.');
  res.sendFile(file);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.status(200).send('OK'));

const server = http.createServer(app);
// Frames are already-compressed JPEG and control messages are tiny — deflate
// just burns CPU on both ends for no benefit. Off = lower latency, less load.
const wss = new WebSocketServer({ server, path: '/stream', perMessageDeflate: false });

// Nagle's algorithm batches small packets for ~40ms before sending — great for
// bulk transfer, bad for an interactive stream. Every connection on this
// server is either a video frame or an input event, so turn it off globally.
server.on('connection', (socket) => socket.setNoDelay(true));

/* ---------------------------------------------------------------- sending */

function sendJSON(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// Frames go out as raw binary JPEG — no base64, ~25% less bytes on the wire.
function sendFrame(ws, session, buffer) {
  session.lastFrameAt = Date.now();
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return; // slow client: skip frame
  ws.send(buffer);
}

async function sendLocation(ws, session) {
  const { page } = session;
  let title = '';
  try {
    title = await page.title();
  } catch (_) {
    /* page may be mid-navigation */
  }
  sendJSON(ws, { type: 'location', url: page.url(), title });
}

/* ---------------------------------------------------------------- browser */

async function initBrowser() {
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
      // Nothing here changes page rendering — it's all Chrome's own background
      // busywork (telemetry, sync, update checks, throttling) that a
      // throwaway headless instance gets zero benefit from paying for.
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-ipc-flooding-protection',
      '--disable-domain-reliability',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      // Audio is never captured or sent to the client, so decoding/mixing it
      // server-side is pure wasted CPU — mute it at the source.
      '--mute-audio',
    ],
  });
  console.log('Headless Chrome ready.');
}

// One page + CDP screencast per visitor. `onFrame` receives raw JPEG buffers,
// `onLocation` fires on navigation so callers can push a `location` message.
async function createSession({ onFrame, onLocation }) {
  if (!browser) throw new Error('Browser is not ready yet.');

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

  const cdp = await page.createCDPSession();
  await cdp.send('Page.enable');

  const session = { page, cdp, lastFrameAt: 0 };

  // Chrome pushes a frame every time the page paints — this is the "video".
  // Ack unblocks Chrome to send the *next* frame, so fire it immediately
  // rather than waiting on the round-trip before delivering this one — that
  // was serializing every frame behind an extra network hop for no reason.
  cdp.on('Page.screencastFrame', (frame) => {
    cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    onFrame(Buffer.from(frame.data, 'base64'));
  });

  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: FRAME_QUALITY,
    maxWidth: VIEWPORT_WIDTH,
    maxHeight: VIEWPORT_HEIGHT,
    everyNthFrame: EVERY_NTH_FRAME,
  });

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) onLocation();
  });
  page.on('load', onLocation);

  // A target=_blank link would otherwise open a page nobody is streaming —
  // pull it back into this visitor's own tab instead of losing it.
  page.on('popup', async (popup) => {
    try {
      const url = popup.url();
      await popup.close().catch(() => {});
      if (url && url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    } catch (_) {}
  });

  try {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (_) {}

  return session;
}

async function destroySession(session) {
  if (!session) return;
  try {
    await session.cdp.detach();
  } catch (_) {}
  try {
    if (!session.page.isClosed()) await session.page.close();
  } catch (_) {}
}

/* ------------------------------------------------------------------ input */

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function modifierMask(m) {
  if (!m) return 0;
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}

// Keys whose text payload Chrome needs but the browser reports as a name.
const KEY_TEXT = { Enter: '\r', NumpadEnter: '\r', Tab: '\t' };

async function dispatchKey(session, msg) {
  const { cdp } = session;
  const key = String(msg.key || '');
  const code = String(msg.code || '');
  const location = Number(msg.location) || 0;
  const isUp = msg.action === 'up';

  // Single characters carry text; named keys (Shift, ArrowUp...) do not.
  let text = KEY_TEXT[code] || (key.length === 1 ? key : '');
  // Ctrl+C is a command, not the letter "c".
  if (msg.modifiers && (msg.modifiers.ctrl || msg.modifiers.meta)) text = '';

  await cdp.send('Input.dispatchKeyEvent', {
    type: isUp ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
    modifiers: modifierMask(msg.modifiers),
    windowsVirtualKeyCode: Number(msg.keyCode) || 0,
    nativeVirtualKeyCode: Number(msg.keyCode) || 0,
    key,
    code,
    location,
    text: isUp ? '' : text,
    unmodifiedText: isUp ? '' : text.toLowerCase(),
    autoRepeat: Boolean(msg.repeat),
    isKeypad: location === 3,
  });
}

const MOUSE_TYPES = {
  down: 'mousePressed',
  up: 'mouseReleased',
  move: 'mouseMoved',
  wheel: 'mouseWheel',
};
const MOUSE_BUTTONS = ['left', 'middle', 'right', 'back', 'forward'];

async function dispatchMouse(session, msg) {
  const { cdp } = session;
  const type = MOUSE_TYPES[msg.action];
  if (!type) return;

  const payload = {
    type,
    x: clamp(msg.x, 0, VIEWPORT_WIDTH),
    y: clamp(msg.y, 0, VIEWPORT_HEIGHT),
    modifiers: modifierMask(msg.modifiers),
    buttons: Number(msg.buttons) || 0,
  };

  if (type === 'mouseWheel') {
    payload.button = 'none';
    payload.deltaX = Number(msg.deltaX) || 0;
    payload.deltaY = Number(msg.deltaY) || 0;
  } else if (type === 'mouseMoved') {
    payload.button = 'none';
    payload.clickCount = 0;
  } else {
    payload.button = MOUSE_BUTTONS[Number(msg.button) || 0] || 'left';
    payload.clickCount = Number(msg.clickCount) || 1;
  }

  await cdp.send('Input.dispatchMouseEvent', payload);
}

/* ------------------------------------------------------------- navigation */

function resolveUrl(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new Error('Enter a URL to open.');
  if (/^(javascript|data|file|blob):/i.test(input)) {
    throw new Error('That scheme is blocked. Use http or https.');
  }
  if (/^https?:\/\//i.test(input)) return input;
  // No dot or has a space? Treat it as a search rather than a dead hostname.
  if (/\s/.test(input) || !input.includes('.')) {
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(input);
  }
  return 'https://' + input;
}

async function navigate(ws, session, raw) {
  const url = resolveUrl(raw);
  sendJSON(ws, { type: 'status', state: 'loading', url });
  await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  sendJSON(ws, { type: 'status', state: 'ready' });
  await sendLocation(ws, session);
}

/* -------------------------------------------------------------- websocket */

async function handleMessage(msg, ws, session) {
  switch (msg.type) {
    case 'navigate':
      return navigate(ws, session, msg.url);
    case 'back':
      await session.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      return sendLocation(ws, session);
    case 'forward':
      await session.page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {});
      return sendLocation(ws, session);
    case 'reload':
      await session.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      return sendLocation(ws, session);
    case 'key':
      return dispatchKey(session, msg);
    case 'mouse':
      return dispatchMouse(session, msg);
    case 'text': // paste, and mobile on-screen keyboards
      return session.cdp.send('Input.insertText', { text: String(msg.text || '') });
    case 'ping':
      return sendJSON(ws, { type: 'pong', t: msg.t });
    default:
      return undefined;
  }
}

wss.on('connection', async (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  if (sessions.size >= MAX_SESSIONS) {
    sendJSON(ws, { type: 'error', message: 'The cloud browser is at capacity — try again shortly.' });
    ws.close();
    return;
  }

  let session;
  try {
    session = await createSession({
      onFrame: (buf) => sendFrame(ws, session, buf),
      onLocation: () => sendLocation(ws, session),
    });
  } catch (err) {
    sendJSON(ws, { type: 'error', message: 'Could not start a browser session: ' + err.message });
    ws.close();
    return;
  }

  sessions.set(ws, session);
  sendJSON(ws, { type: 'hello', width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
  await sendLocation(ws, session);

  // Show the joiner the current page immediately instead of waiting for a repaint.
  try {
    const frame = await session.page.screenshot({ type: 'jpeg', quality: FRAME_QUALITY });
    if (ws.readyState === ws.OPEN) ws.send(frame);
  } catch (_) {}

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    try {
      await handleMessage(msg, ws, session);
    } catch (err) {
      sendJSON(ws, { type: 'error', message: err.message });
    }
  });

  const cleanup = () => {
    sessions.delete(ws);
    destroySession(session);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// The screencast only fires on repaint, so a still page sends nothing.
// This keeps late joiners and idle sessions from staring at a blank canvas.
setInterval(async () => {
  for (const [ws, session] of sessions) {
    if (ws.readyState !== ws.OPEN) continue;
    if (Date.now() - session.lastFrameAt < IDLE_REFRESH_MS) continue;
    try {
      const buf = await session.page.screenshot({ type: 'jpeg', quality: FRAME_QUALITY });
      sendFrame(ws, session, buf);
    } catch (_) {}
  }
}, IDLE_REFRESH_MS);

const heartbeat = setInterval(() => {
  for (const ws of sessions.keys()) {
    if (!ws.isAlive) {
      ws.terminate(); // triggers 'close' above, which tears down the session
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

/* ----------------------------------------------------- legacy REST routes */
// Kept so anything still calling the old endpoints keeps working. They all
// share one dedicated session rather than a per-visitor one, since a bare
// HTTP request has no persistent connection to key a session off of.

async function getRestSession() {
  if (restSession && !restSession.page.isClosed()) return restSession;
  restSession = await createSession({ onFrame: () => {}, onLocation: () => {} });
  return restSession;
}

app.post('/navigate', async (req, res) => {
  try {
    const session = await getRestSession();
    await navigate({ readyState: -1 /* no ws to notify */ }, session, req.body.url);
    const shot = await session.page.screenshot({ encoding: 'base64', type: 'jpeg', quality: FRAME_QUALITY });
    res.json({ screenshot: `data:image/jpeg;base64,${shot}`, currentUrl: session.page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/click', async (req, res) => {
  try {
    const { x, y } = req.body;
    if (x === undefined || y === undefined) {
      return res.status(400).json({ error: 'Coordinates missing' });
    }
    const session = await getRestSession();
    await session.page.mouse.click(clamp(x, 0, VIEWPORT_WIDTH), clamp(y, 0, VIEWPORT_HEIGHT));
    await new Promise((r) => setTimeout(r, 500));
    const shot = await session.page.screenshot({ encoding: 'base64', type: 'jpeg', quality: FRAME_QUALITY });
    res.json({ screenshot: `data:image/jpeg;base64,${shot}`, currentUrl: session.page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/type', async (req, res) => {
  try {
    const session = await getRestSession();
    await session.cdp.send('Input.insertText', { text: String(req.body.text || '') });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ start */

initBrowser()
  .then(() => {
    server.listen(PORT, () => console.log(`Cloud browser streaming on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to launch browser:', err);
    process.exit(1);
  });

async function shutdown() {
  clearInterval(heartbeat);
  for (const [ws, session] of sessions) {
    ws.close();
    await destroySession(session);
  }
  if (restSession) await destroySession(restSession);
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
