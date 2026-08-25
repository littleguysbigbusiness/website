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

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------- state */

let browser = null;
let page = null;
let cdp = null;
let lastFrameAt = 0;
const clients = new Set();

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
const wss = new WebSocketServer({ server, path: '/stream' });

/* -------------------------------------------------------------- broadcast */

function sendJSON(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastJSON(obj) {
  const payload = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

// Frames go out as raw binary JPEG — no base64, ~25% less bytes on the wire.
function broadcastFrame(buffer) {
  lastFrameAt = Date.now();
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) continue; // slow client: skip frame
    ws.send(buffer);
  }
}

async function broadcastLocation() {
  if (!page) return;
  let title = '';
  try {
    title = await page.title();
  } catch (_) {
    /* page may be mid-navigation */
  }
  broadcastJSON({ type: 'location', url: page.url(), title });
}

/* ---------------------------------------------------------------- browser */

async function attachPage(target) {
  page = target;
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
  try {
    await page.bringToFront();
  } catch (_) {}

  if (cdp) {
    try {
      await cdp.detach();
    } catch (_) {}
    cdp = null;
  }

  cdp = await page.createCDPSession();
  await cdp.send('Page.enable');

  // Chrome pushes a frame every time the page paints — this is the "video".
  cdp.on('Page.screencastFrame', async (frame) => {
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
    } catch (_) {}
    broadcastFrame(Buffer.from(frame.data, 'base64'));
  });

  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: FRAME_QUALITY,
    maxWidth: VIEWPORT_WIDTH,
    maxHeight: VIEWPORT_HEIGHT,
    everyNthFrame: EVERY_NTH_FRAME,
  });

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) broadcastLocation();
  });
  page.on('load', broadcastLocation);

  broadcastLocation();
}

async function initBrowser() {
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
    ],
  });

  await attachPage(await browser.newPage());

  // Links that open a new tab would otherwise stream nothing — follow them.
  browser.on('targetcreated', async (target) => {
    if (target.type() !== 'page') return;
    try {
      const opened = await target.page();
      if (opened) await attachPage(opened);
    } catch (err) {
      console.error('Could not follow new tab:', err.message);
    }
  });

  browser.on('targetdestroyed', async (target) => {
    if (target.type() !== 'page' || !page || !page.isClosed()) return;
    const pages = await browser.pages();
    const survivor = pages.find((p) => !p.isClosed());
    if (survivor) await attachPage(survivor);
  });

  try {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (_) {}

  console.log('Headless Chrome ready.');
}

// The screencast only fires on repaint, so a still page sends nothing.
// This keeps late joiners and idle sessions from staring at a blank canvas.
setInterval(async () => {
  if (!page || clients.size === 0) return;
  if (Date.now() - lastFrameAt < IDLE_REFRESH_MS) return;
  try {
    broadcastFrame(await page.screenshot({ type: 'jpeg', quality: FRAME_QUALITY }));
  } catch (_) {}
}, IDLE_REFRESH_MS);

/* ------------------------------------------------------------------ input */

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function modifierMask(m) {
  if (!m) return 0;
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}

// Keys whose text payload Chrome needs but the browser reports as a name.
const KEY_TEXT = { Enter: '\r', NumpadEnter: '\r', Tab: '\t' };

async function dispatchKey(msg) {
  if (!cdp) return;
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

async function dispatchMouse(msg) {
  if (!cdp) return;
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

async function navigate(raw) {
  const url = resolveUrl(raw);
  broadcastJSON({ type: 'status', state: 'loading', url });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  broadcastJSON({ type: 'status', state: 'ready' });
  await broadcastLocation();
}

/* -------------------------------------------------------------- websocket */

async function handleMessage(msg, ws) {
  switch (msg.type) {
    case 'navigate':
      return navigate(msg.url);
    case 'back':
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      return broadcastLocation();
    case 'forward':
      await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {});
      return broadcastLocation();
    case 'reload':
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      return broadcastLocation();
    case 'key':
      return dispatchKey(msg);
    case 'mouse':
      return dispatchMouse(msg);
    case 'text': // paste, and mobile on-screen keyboards
      return cdp.send('Input.insertText', { text: String(msg.text || '') });
    case 'ping':
      return sendJSON(ws, { type: 'pong', t: msg.t });
    default:
      return undefined;
  }
}

wss.on('connection', async (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  sendJSON(ws, { type: 'hello', width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
  broadcastLocation();

  // Show the joiner the current page immediately instead of waiting for a repaint.
  try {
    const frame = await page.screenshot({ type: 'jpeg', quality: FRAME_QUALITY });
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
      await handleMessage(msg, ws);
    } catch (err) {
      sendJSON(ws, { type: 'error', message: err.message });
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) {
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

/* ----------------------------------------------------- legacy REST routes */
// Kept so anything still calling the old endpoints keeps working.

app.post('/navigate', async (req, res) => {
  try {
    await navigate(req.body.url);
    const shot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: FRAME_QUALITY });
    res.json({ screenshot: `data:image/jpeg;base64,${shot}`, currentUrl: page.url() });
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
    await page.mouse.click(clamp(x, 0, VIEWPORT_WIDTH), clamp(y, 0, VIEWPORT_HEIGHT));
    await new Promise((r) => setTimeout(r, 500));
    const shot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: FRAME_QUALITY });
    res.json({ screenshot: `data:image/jpeg;base64,${shot}`, currentUrl: page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/type', async (req, res) => {
  try {
    await cdp.send('Input.insertText', { text: String(req.body.text || '') });
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
  for (const ws of clients) ws.close();
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
