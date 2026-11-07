// Drives the real VS Code UI in headless Chromium through `code serve-web`.
// Nothing opens on screen, and the user's own VS Code profile isn't touched.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

export const ROOT = resolve(new URL('../..', import.meta.url).pathname);
export const OUT = join(ROOT, 'test/e2e/out');

/** Finds the VS Code server binary, downloading it through `code serve-web` the first time. */
async function serverBinary(dataDir, port) {
  const root = join(dataDir, 'cli', 'serve-web');
  const find = () => {
    if (!existsSync(root)) return undefined;
    for (const d of readdirSync(root)) {
      if (d.includes('.staging')) continue;
      const bin = join(root, d, 'bin', 'code-server');
      if (existsSync(bin)) return bin;
    }
    return undefined;
  };
  if (find()) return find();
  const boot = spawn('code', ['serve-web', '--without-connection-token', '--accept-server-license-terms', '--host', '127.0.0.1', '--port', String(port), '--cli-data-dir', join(dataDir, 'cli')], { stdio: 'ignore', detached: true });
  const stopAt = Date.now() + 240000;
  while (!find() && Date.now() < stopAt) {
    await fetch(`http://127.0.0.1:${port}`).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1000));
  }
  try { process.kill(-boot.pid, 'SIGTERM'); } catch { /* Already gone. */ }
  await new Promise((r) => setTimeout(r, 1000));
  return find();
}

export async function startVSCode({ port = 8765, workspace, dataDir, colorTheme = 'Default Dark Modern', settings = {} }) {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const bin = await serverBinary(dataDir, port);
  if (!bin) throw new Error('Could not get the VS Code server.');
  // Load the working copy as if installed, in a profile only this test uses.
  const extDir = join(dataDir, 'extensions');
  mkdirSync(extDir, { recursive: true });
  const link = join(extDir, 'maximebf.mongo-viewer-0.1.0');
  // MV_E2E_EXTENSION tests a packaged build instead of the working copy.
  rmSync(link, { recursive: true, force: true });
  symlinkSync(process.env.MV_E2E_EXTENSION || ROOT, link);
  const server = spawn(bin, [
    '--without-connection-token', '--accept-server-license-terms', '--disable-workspace-trust', '--disable-telemetry',
    '--host', '127.0.0.1', '--port', String(port),
    '--server-data-dir', join(dataDir, 'server'),
    '--extensions-dir', extDir,
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 240000;
  for (;;) {
    try {
      const r = await fetch(base);
      if (r.ok) break;
    } catch { /* Not up yet. */ }
    if (server.exitCode !== null) throw new Error(`serve-web exited:\n${log}`);
    if (Date.now() > deadline) throw new Error(`serve-web did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  // Set MV_CHROME to reuse a browser that's already installed instead of downloading one.
  const browser = await chromium.launch({ headless: true, executablePath: process.env.MV_CHROME || undefined });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, colorScheme: 'dark', permissions: ['clipboard-read', 'clipboard-write'] });
  context.setDefaultTimeout(8000);
  const page = await context.newPage();
  mkdirSync(join(workspace, '.vscode'), { recursive: true });
  writeFileSync(join(workspace, '.vscode', 'settings.json'), JSON.stringify({
    'workbench.colorTheme': colorTheme,
    'workbench.startupEditor': 'none',
    'chat.disableAIFeatures': true,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'window.commandCenter': false,
    ...settings,
  }, null, 2));
  await page.goto(`${base}/?folder=${encodeURIComponent(workspace)}`);
  await page.waitForSelector('.monaco-workbench', { timeout: 120000 });
  return { page, browser, server, base, getLog: () => log };
}

export async function stopVSCode(h) {
  await h.browser?.close().catch(() => undefined);
  // The server runs as its own process group, so this stops all of its children too.
  try { process.kill(-h.server.pid, 'SIGTERM'); } catch { /* Already gone. */ }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a command through the real Command Palette. */
export async function command(page, title) {
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input.input');
  await input.waitFor({ state: 'visible' });
  await input.fill(`>${title}`);
  await sleep(350);
  await page.keyboard.press('Enter');
  await sleep(300);
}

/** Finds the frame that holds a webview's #app with the given view. */
export async function webview(page, view, { timeout = 20000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      try {
        if (await f.locator(`#app[data-view="${view}"]`).count()) {
          // A hidden tab keeps its webview alive, so check every enclosing frame is showing.
          let visible = true;
          for (let cur = f; cur.parentFrame(); cur = cur.parentFrame()) {
            const el = await cur.frameElement();
            if (!(await el.isVisible())) { visible = false; break; }
          }
          if (visible) return f;
        }
      } catch { /* Frame went away while checking. */ }
    }
    await sleep(150);
  }
  throw new Error(`webview "${view}" not found`);
}

export async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

let passed = 0;
const failures = [];
export async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name} (${Date.now() - t} ms)`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(err.message).split('\n').slice(0, 4).join('\n       ')}`);
    await step.onFail?.(name);
  }
}
export const report = () => ({ passed, failures });

export function resetDir(p) {
  // Only ever called with a path inside this test's own data directory.
  rmSync(p, { recursive: true, force: true });
  mkdirSync(p, { recursive: true });
}
export { writeFileSync };
