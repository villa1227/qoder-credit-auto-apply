/**
 * Minimal Chrome DevTools Protocol driver (no npm dependencies).
 *
 * Uses Node's built-in WebSocket (Node >= 22) and fetch to talk to a local
 * Edge/Chrome instance started with --remote-debugging-port.
 *
 * All page interaction is done with Runtime.evaluate, i.e. plain DOM operations
 * inside the page, which keeps the driver small and robust for form filling.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_PORT = 9333;

export const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findBrowserBinary() {
  for (const path of EDGE_PATHS) if (existsSync(path)) return path;
  throw new Error('BROWSER_BINARY_NOT_FOUND');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function isPortAlive(port = DEFAULT_PORT) {
  try {
    const info = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    return Boolean(info?.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

/** Start a local browser with a dedicated profile so the login session persists. */
export async function launchBrowser({ port = DEFAULT_PORT, profileDir, headless = false } = {}) {
  const binary = findBrowserBinary();
  if (!profileDir) throw new Error('PROFILE_DIR_REQUIRED');
  mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  const child = spawn(binary, args, { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 40; i += 1) {
    if (await isPortAlive(port)) return { port, profileDir, pid: child.pid };
    await sleep(500);
  }
  throw new Error('BROWSER_START_TIMEOUT');
}

export class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', (event) => this.handleMessage(event.data));
    socket.addEventListener('close', () => {
      for (const [, entry] of this.pending) entry.reject(new Error('CDP_CONNECTION_CLOSED'));
      this.pending.clear();
    });
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
      else entry.resolve(message.result);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP_TIMEOUT:${method}`));
      }, 60000);
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
  }
}

export class Browser {
  constructor(socket, port) {
    this.session = new CdpSession(socket);
    this.port = port;
  }

  static async connect(port = DEFAULT_PORT) {
    const info = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    if (!info?.webSocketDebuggerUrl) throw new Error('BROWSER_NOT_AVAILABLE');
    const socket = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('BROWSER_CONNECT_FAILED')), { once: true });
    });
    return new Browser(socket, port);
  }

  async newPage(url = 'about:blank') {
    const { targetId } = await this.session.send('Target.createTarget', { url });
    const { sessionId } = await this.session.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.session, sessionId, targetId);
    await page.init();
    return page;
  }

  /** All open page targets (tabs). */
  async listPages() {
    const { targetInfos } = await this.session.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page');
  }

  /** Attach to an existing tab so we reuse the window the user is interacting with. */
  async attach(targetId) {
    const { sessionId } = await this.session.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.session, sessionId, targetId);
    await page.init();
    return page;
  }

  /**
   * Bring a tab (and its window) to the front.
   * Required before dispatching input events: a background tab silently drops
   * mouse events, and the portal's "立即申请" opens a popup that Chrome only
   * allows for real user gestures.
   */
  async activate(targetId) {
    await this.session.send('Target.activateTarget', { targetId });
  }

  /**
   * Reuse an existing tab matching the predicate; fall back to opening a new one.
   * Reusing matters for the PKU login: the user completes it in a visible window,
   * and the automation must follow that very tab.
   */
  async reusePage(predicate, url = 'about:blank') {
    const pages = await this.listPages();
    const hit = pages.find((t) => {
      try {
        return predicate(t);
      } catch {
        return false;
      }
    });
    if (hit) return this.attach(hit.targetId);
    return this.newPage(url);
  }

  close() {
    this.session.close();
  }
}

export class Page {
  constructor(session, sessionId, targetId) {
    this.session = session;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  send(method, params = {}) {
    return this.session.send(method, params, this.sessionId);
  }

  async navigate(url, { waitMs = 30000 } = {}) {
    await this.send('Page.navigate', { url });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const state = await this.evaluate('return { ready: document.readyState, url: location.href };');
      if (state?.ready === 'complete') return state.url;
      await sleep(300);
    }
    return this.url();
  }

  async url() {
    const result = await this.evaluate('return location.href;');
    return typeof result === 'string' ? result : null;
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(function(){ ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) {
      throw new Error(`EVAL_ERROR:${result.exceptionDetails.text ?? 'unknown'}`);
    }
    return result?.result?.value;
  }

  /**
   * Dispatch a real (trusted) mouse click at viewport coordinates.
   * A synthetic el.click() is not a user gesture, so the browser blocks popups
   * opened by the portal's "立即申请" button.
   */
  async clickAt(x, y) {
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async screenshot(filePath) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(filePath, Buffer.from(result.data, 'base64'));
    return filePath;
  }

  async bringToFront() {
    try {
      await this.send('Page.bringToFront');
    } catch {
      /* ignore */
    }
  }

  /**
   * Make this tab the active one and restore its window if it is minimized.
   * Without this, CDP mouse events are silently dropped by the browser.
   */
  async activate() {
    try {
      const { windowId } = await this.session.send('Browser.getWindowForTarget', { targetId: this.targetId });
      const { bounds } = await this.session.send('Browser.getWindowBounds', { windowId });
      if (bounds?.windowState === 'minimized') {
        await this.session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      }
    } catch {
      /* ignore */
    }
    try {
      await this.session.send('Target.activateTarget', { targetId: this.targetId });
    } catch {
      /* ignore */
    }
    await this.bringToFront();
  }

  async close() {
    try {
      await this.session.send('Target.closeTarget', { targetId: this.targetId });
    } catch {
      /* ignore */
    }
  }
}

export { sleep };
