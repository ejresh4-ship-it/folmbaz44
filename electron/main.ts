// Electron main process entry point for FILM BAZ.
//
// SECURITY: contextIsolation is enabled, nodeIntegration is disabled.
// The preload script exposes only a restricted API via contextBridge.
// No unrestricted filesystem or shell access is exposed to the renderer.

import { app, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawn, execSync as nodeExecSync } from 'node:child_process';
import type { DirEntry, FileInfo, MoveResult } from '../src/types/filesystem';
import type { DetectedPlayer, PlaybackResult } from '../src/types/desktop';

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

type LanRoot = { id: string; name: string; path: string };
let lanServer: Server | null = null;
let lanPin = '';
let lanPort = 47821;
let lanRoots: LanRoot[] = [];
const lanTokens = new Set<string>();
const lanSelectedPaths = new Set<string>();
const lanPairAttempts = new Map<string, { count: number; since: number }>();

function lanJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  });
  res.end(JSON.stringify(data));
}

function lanMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.wmv': 'video/x-ms-wmv',
    '.webm': 'video/webm', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
    '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.3gp': 'video/3gpp',
    '.srt': 'application/x-subrip', '.ass': 'text/plain; charset=utf-8', '.ssa': 'text/plain; charset=utf-8',
    '.vtt': 'text/vtt; charset=utf-8', '.sub': 'text/plain; charset=utf-8', '.smi': 'application/smil; charset=utf-8',
  };
  return types[ext] || 'application/octet-stream';
}

async function lanSidecarSubtitles(root: LanRoot, videoPath: string): Promise<Array<{ name: string; path: string; language: string }>> {
  const videoStem = path.basename(videoPath, path.extname(videoPath)).toLocaleLowerCase();
  const subtitleExtensions = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub', '.smi']);
  let entries: fs.Dirent[] = [];
  try { entries = await fs.promises.readdir(path.dirname(videoPath), { withFileTypes: true }); } catch { return []; }
  const matches = entries.flatMap((entry) => {
    if (!entry.isFile()) return [];
    const extension = path.extname(entry.name).toLowerCase();
    if (!subtitleExtensions.has(extension)) return [];
    const stem = path.basename(entry.name, extension).toLocaleLowerCase();
    if (stem !== videoStem && !stem.startsWith(videoStem + '.')) return [];
    const fullPath = path.join(path.dirname(videoPath), entry.name);
    return [{
      name: entry.name,
      path: path.relative(root.path, fullPath).split(path.sep).join('/'),
      language: /(^|\\.)(fa|fas|per|persian)(\\.|$)/i.test(stem) ? 'fa' : '',
    }];
  });
  return matches.sort((a, b) =>
    Number(b.language === 'fa') - Number(a.language === 'fa') ||
    Number(path.basename(a.name, path.extname(a.name)).toLowerCase() !== videoStem) -
    Number(path.basename(b.name, path.extname(b.name)).toLowerCase() !== videoStem) ||
    a.name.localeCompare(b.name));
}

function lanAuthorized(req: IncomingMessage, urlToken?: string | null): boolean {
  const header = req.headers.authorization || '';
  const candidate = header.startsWith('Bearer ') ? header.slice(7) : (urlToken || '');
  if (!candidate) return false;
  const supplied = Buffer.from(candidate);
  for (const token of lanTokens) {
    const expected = Buffer.from(token);
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return true;
  }
  return false;
}

async function lanResolve(root: LanRoot, relativePath: string): Promise<string | null> {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.some((part) => part === '.' || part === '..' || part.includes('\0'))) return null;
  const candidate = path.resolve(root.path, ...segments);
  const relative = path.relative(root.path, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    const realRoot = await fs.promises.realpath(root.path);
    const realCandidate = await fs.promises.realpath(candidate);
    const realRelative = path.relative(realRoot, realCandidate);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) return null;
    return realCandidate;
  } catch { return null; }
}

function lanClientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress || 'unknown';
}

async function handleLanRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD', 'Access-Control-Max-Age': '600' }); res.end(); return; }
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  if (requestUrl.pathname === '/pair' && req.method === 'POST') {
    const ip = lanClientIp(req);
    const now = Date.now();
    const attempts = lanPairAttempts.get(ip) || { count: 0, since: now };
    if (now - attempts.since > 120_000) { attempts.count = 0; attempts.since = now; }
    attempts.count += 1;
    lanPairAttempts.set(ip, attempts);
    if (attempts.count > 8) { lanJson(res, 429, { error: 'تعداد تلاش‌ها زیاد است؛ دو دقیقه بعد دوباره امتحان کن.' }); return; }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk.toString();
      if (raw.length > 2048) { lanJson(res, 413, { error: 'درخواست بیش از حد بزرگ است.' }); return; }
    }
    let submitted = '';
    try { submitted = String((JSON.parse(raw) as { pin?: unknown }).pin || ''); } catch { /* invalid JSON */ }
    if (!/^\d{6}$/.test(submitted) || submitted !== lanPin) {
      lanJson(res, 401, { error: 'کد اتصال نادرست یا منقضی شده است.' }); return;
    }
    const token = randomBytes(32).toString('base64url');
    lanTokens.add(token);
    lanPairAttempts.delete(ip);
    lanJson(res, 200, { token });
    return;
  }

  if (!lanAuthorized(req, (requestUrl.pathname === '/api/stream' || requestUrl.pathname === '/api/subtitle') ? requestUrl.searchParams.get('accessToken') : null)) { lanJson(res, 401, { error: 'دسترسی غیرمجاز است؛ ابتدا جفت‌سازی کن.' }); return; }

  if (requestUrl.pathname === '/api/info' && req.method === 'GET') { lanJson(res, 200, { name: 'FILM BAZ', version: app.getVersion(), protocol: 1 }); return; }

  if (requestUrl.pathname === '/api/roots' && req.method === 'GET') {
    lanJson(res, 200, { roots: lanRoots.map(({ id, name }) => ({ id, name })) }); return;
  }

  const rootId = requestUrl.searchParams.get('rootId') || '';
  const root = lanRoots.find((entry) => entry.id === rootId);
  if (!root) { lanJson(res, 404, { error: 'پوشه اشتراکی پیدا نشد.' }); return; }

  const relativePath = requestUrl.searchParams.get('path') || '';
  const filePath = await lanResolve(root, relativePath);
  if (!filePath) { lanJson(res, 404, { error: 'مسیر فایل معتبر نیست یا فایل وجود ندارد.' }); return; }

  if (requestUrl.pathname === '/api/files' && req.method === 'GET') {
    try {
      const entries = await fs.promises.readdir(filePath, { withFileTypes: true });
      const result = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(filePath, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          if (!stat.isDirectory() && !stat.isFile()) continue;
          const relativeEntryPath = path.relative(root.path, fullPath).split(path.sep).join('/');
          const mime = stat.isFile() ? lanMime(fullPath) : 'inode/directory';
          const subtitles = stat.isFile() && mime.startsWith('video/') ? await lanSidecarSubtitles(root, fullPath) : [];
          result.push({
            name: entry.name,
            isDirectory: stat.isDirectory(),
            size: stat.size,
            mime,
            path: relativeEntryPath,
            subtitles,
          });
        } catch { /* ignore inaccessible entries */ }
      }
      result.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
      lanJson(res, 200, { entries: result });
    } catch { lanJson(res, 400, { error: 'خواندن پوشه ناموفق بود.' }); }
    return;
  }

  if (requestUrl.pathname === '/api/subtitle' && req.method === 'GET') {
    try {
      const extension = path.extname(filePath).toLowerCase();
      const subtitleExtensions = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub', '.smi']);
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || !subtitleExtensions.has(extension)) {
        lanJson(res, 403, { error: 'فقط فایل زیرنویس قابل دریافت است.' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': lanMime(filePath),
        'Content-Length': stat.size,
        'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(path.basename(filePath)),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      const subtitleStream = fs.createReadStream(filePath);
      subtitleStream.on('error', () => res.destroy());
      subtitleStream.pipe(res);
    } catch {
      lanJson(res, 404, { error: 'زیرنویس برای دریافت در دسترس نیست.' });
    }
    return;
  }

  if (requestUrl.pathname === '/api/stream' && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) { lanJson(res, 400, { error: 'مسیر انتخاب‌شده فایل نیست.' }); return; }
      const mime = lanMime(filePath);
      const range = req.headers.range;
      const match = range?.match(/^bytes=(\d*)-(\d*)$/);
      if (match) {
        const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 0));
        const end = match[2] && match[1] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Access-Control-Allow-Origin': '*' }); res.end(); return;
        }
        res.writeHead(206, {
          'Content-Type': mime, 'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Range',
          'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') { res.end(); return; }
        const stream = fs.createReadStream(filePath, { start, end });
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Type': mime, 'Content-Length': stat.size,
          'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Range',
          'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') { res.end(); return; }
        const stream = fs.createReadStream(filePath);
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      }
    } catch { lanJson(res, 404, { error: 'فایل برای پخش در دسترس نیست.' }); }
    return;
  }
  lanJson(res, 404, { error: 'مسیر در سرویس FILM BAZ وجود ندارد.' });
}

async function stopLanHost(): Promise<void> {
  const server = lanServer;
  lanServer = null;
  lanPin = '';
  lanTokens.clear();
  lanPairAttempts.clear();
  lanRoots = [];
  if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}

async function startLanHost(paths: string[], requestedPort: number): Promise<{ success: boolean; message: string; port?: number; pin?: string; addresses?: string[] }> {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 20 || paths.some((p) => typeof p !== 'string' || !lanSelectedPaths.has(p))) {
    return { success: false, message: 'حداقل یک و حداکثر ۲۰ پوشه را برای اشتراک انتخاب کن.' };
  }
  if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) {
    return { success: false, message: 'شماره پورت باید بین ۱۰۲۴ تا ۶۵۵۳۵ باشد.' };
  }
  const roots: LanRoot[] = [];
  for (const selected of paths) {
    try {
      const real = await fs.promises.realpath(selected);
      const stat = await fs.promises.stat(real);
      if (!stat.isDirectory()) continue;
      roots.push({ id: randomBytes(8).toString('hex'), name: path.basename(real) || real, path: real });
    } catch { /* ignore invalid selected folders */ }
  }
  if (!roots.length) return { success: false, message: 'هیچ پوشه معتبر و قابل‌دسترسی انتخاب نشده است.' };
  await stopLanHost();
  lanRoots = roots;
  lanPort = requestedPort;
  lanPin = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const server = createServer((req, res) => { void handleLanRequest(req, res).catch(() => lanJson(res, 500, { error: 'خطای داخلی سرویس محلی.' })); });
  lanServer = server;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(lanPort, '0.0.0.0', () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    lanServer = null; lanRoots = []; lanPin = '';
    return { success: false, message: error instanceof Error ? error.message : 'اجرای سرویس محلی ناموفق بود.' };
  }
  const addresses = Object.values(os.networkInterfaces()).flatMap((items) =>
    (items || []).filter((item) => !item.internal && item.family === 'IPv4').map((item) => item.address));
  return { success: true, message: 'سرویس اشتراک‌گذاری در شبکه محلی فعال شد.', port: lanPort, pin: lanPin, addresses };
}


app.setAppUserModelId('com.filmbaz.desktop');

let mainWindow: BrowserWindow | null = null;
const cancelledScans = new Set<string>();
let localAiProcess: ReturnType<typeof spawn> | null = null;
let localAiProcessKey = '';

async function waitForLocalAi(child: ReturnType<typeof spawn>, port: number, timeoutMs = 120000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null || localAiProcess !== child) return false;
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health', {
        signal: AbortSignal.timeout(1200),
      });
      if (response.ok) return true;
    } catch { /* the model is still loading */ }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return false;
}

async function stopLocalAi(): Promise<void> {
  const child = localAiProcess;
  localAiProcess = null;
  localAiProcessKey = '';
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    backgroundColor: '#070a12',
    title: 'فیلم باز — FILM BAZ',
    icon: path.join(app.getAppPath(), 'src-tauri', 'icons', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // In dev mode, load from the Vite dev server; in production, load the built file.
  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../../dist/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});


// --- IPC: Local Wi-Fi sharing host (inside the desktop app) ---
ipcMain.handle('lan:chooseFolders', async () => {
  const options = {
    title: 'انتخاب پوشه‌های مجاز برای اشتراک با گوشی',
    properties: ['openDirectory', 'multiSelections'] as Array<'openDirectory' | 'multiSelections'>,
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return [];
  const selected: string[] = [];
  for (const candidate of result.filePaths) {
    try {
      const real = await fs.promises.realpath(candidate);
      if ((await fs.promises.stat(real)).isDirectory()) {
        lanSelectedPaths.add(real);
        selected.push(real);
      }
    } catch { /* ignore unavailable paths */ }
  }
  return selected;
});
ipcMain.handle('lan:start', async (_evt, paths: string[], port: number) => startLanHost(paths, port));
ipcMain.handle('lan:stop', async () => { await stopLanHost(); return { success: true }; });
ipcMain.handle('lan:status', async () => ({
  running: Boolean(lanServer?.listening),
  port: lanServer?.listening ? lanPort : null,
  connectedDevices: lanTokens.size,
  pin: lanServer?.listening ? lanPin : undefined,
  addresses: lanServer?.listening ? Object.values(os.networkInterfaces()).flatMap((items) => (items || []).filter((item) => !item.internal && item.family === 'IPv4').map((item) => item.address)) : [],
}));

// --- IPC: Managed local offline AI ---
ipcMain.handle('ai:browseServer', async (): Promise<string | null> => {
  const options = {
    title: 'انتخاب llama-server.exe',
    filters: [{ name: 'برنامه اجرایی', extensions: ['exe'] }],
    properties: ['openFile'] as Array<'openFile'>,
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle('ai:browseModel', async (): Promise<string | null> => {
  const options = {
    title: 'انتخاب فایل مدل GGUF',
    filters: [{ name: 'مدل GGUF', extensions: ['gguf'] }],
    properties: ['openFile'] as Array<'openFile'>,
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle('ai:startLocal', async (
  _evt,
  serverPath: string,
  modelPath: string,
  port: number,
): Promise<{ success: boolean; message: string }> => {
  if (process.platform !== 'win32') {
    return { success: false, message: 'اجرای خودکار مدل فعلاً فقط در نسخه ویندوز فعال است.' };
  }
  if (typeof serverPath !== 'string' || typeof modelPath !== 'string'
    || !path.isAbsolute(serverPath) || !path.isAbsolute(modelPath)) {
    return { success: false, message: 'مسیر فایل سرور یا مدل معتبر نیست.' };
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { success: false, message: 'شماره پورت باید بین ۱۰۲۴ تا ۶۵۵۳۵ باشد.' };
  }

  try {
    const [serverStat, modelStat] = await Promise.all([
      fs.promises.stat(serverPath),
      fs.promises.stat(modelPath),
    ]);
    const serverName = path.basename(serverPath).toLowerCase();
    if (!serverStat.isFile() || !/^llama-server(?:[._-][a-z0-9._-]+)?\.exe$/.test(serverName)) {
      return { success: false, message: 'فقط فایل اجرایی llama-server.exe یا نسخه‌های بهینه‌شده آن قابل اجرا است.' };
    }
    if (!modelStat.isFile() || path.extname(modelPath).toLowerCase() !== '.gguf') {
      return { success: false, message: 'فایل انتخاب‌شده مدل GGUF معتبر نیست.' };
    }
  } catch {
    return { success: false, message: 'فایل سرور یا مدل در مسیر انتخاب‌شده پیدا نشد.' };
  }

  const processKey = [serverPath.toLowerCase(), modelPath.toLowerCase(), port].join('|');
  try {
    const existing = await fetch('http://127.0.0.1:' + port + '/health', {
      signal: AbortSignal.timeout(1200),
    });
    if (existing.ok) return { success: true, message: 'سرور محلی روی این پورت از قبل آماده است.' };
  } catch { /* no ready server on this port */ }

  if (localAiProcess && localAiProcess.exitCode === null && localAiProcess.signalCode === null) {
    if (localAiProcessKey === processKey) {
      const ready = await waitForLocalAi(localAiProcess, port, 3000);
      if (ready) return { success: true, message: 'مدل آفلاین از قبل اجرا شده است.' };
    }
    await stopLocalAi();
  }

  try {
    const child = spawn(serverPath, [
      '-m', modelPath,
      '-c', '2048',
      '-t', '2',
      '-ngl', '0',
      '--host', '127.0.0.1',
      '--port', String(port),
    ], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      cwd: path.dirname(serverPath),
    });
    localAiProcess = child;
    localAiProcessKey = processKey;
    child.once('exit', () => {
      if (localAiProcess === child) {
        localAiProcess = null;
        localAiProcessKey = '';
      }
    });
    child.once('error', () => {
      if (localAiProcess === child) {
        localAiProcess = null;
        localAiProcessKey = '';
      }
    });

    const ready = await waitForLocalAi(child, port);
    if (!ready) {
      await stopLocalAi();
      return {
        success: false,
        message: 'مدل در زمان تعیین‌شده آماده نشد. مسیرها، سازگاری نسخه llama.cpp و حافظه آزاد را بررسی کن.',
      };
    }
    return { success: true, message: 'مدل آفلاین با موفقیت اجرا شد.' };
  } catch (error) {
    await stopLocalAi();
    return {
      success: false,
      message: error instanceof Error ? error.message : 'اجرای سرور محلی ناموفق بود.',
    };
  }
});

ipcMain.handle('ai:stopLocal', async (): Promise<void> => {
  await stopLocalAi();
});

app.on('before-quit', () => {
  void stopLocalAi();
  void stopLanHost();
});

// Download remote artwork in Electron's main process. This avoids renderer CORS
// restrictions while keeping filesystem access out of the renderer.
ipcMain.handle('images:download', async (_evt, imageUrl: string): Promise<string | null> => {
  try {
    if (typeof imageUrl !== 'string' || imageUrl.length > 4096) return null;
    const parsed = new URL(imageUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
      || host === '::1' || host.startsWith('127.') || host.startsWith('10.')
      || host.startsWith('192.168.') || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)
      || host === '0.0.0.0' || host === '169.254.169.254') return null;
    const response = await fetch(parsed.toString(), {
      headers: { 'User-Agent': 'FILM-BAZ/1.0 (artwork cache)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/') || contentType === 'image/svg+xml') return null;
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > 12 * 1024 * 1024) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) return null;
    return `data:${contentType};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
});

// --- IPC: Filesystem operations ---

ipcMain.handle('fs:listDir', async (_evt, dirPath: string): Promise<DirEntry[]> => {
  // Fail closed: permission/stat errors must never look like an empty directory.
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const results: DirEntry[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const stat = await fs.promises.lstat(fullPath);
    results.push({
      name: entry.name,
      path: fullPath,
      isDirectory: stat.isDirectory() && !stat.isSymbolicLink(),
      isFile: stat.isFile(),
      isSymlink: stat.isSymbolicLink(),
      size: stat.size,
      lastModified: stat.mtimeMs,
    });
  }
  return results;
});

ipcMain.handle('fs:scanDir', async (
  _evt,
  dirPath: string,
  onProgressChannel: string,
  scanId: string,
): Promise<DirEntry[]> => {
  const results: DirEntry[] = [];
  let scanned = 0;

  async function walk(dir: string): Promise<void> {
    if (cancelledScans.has(scanId)) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (cancelledScans.has(scanId)) return;
      const fullPath = path.join(dir, entry.name);
      let stat: fs.Stats | null = null;
      try {
        stat = await fs.promises.stat(fullPath);
      } catch {
        // skip
      }
      const dirEntry: DirEntry = {
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymlink: entry.isSymbolicLink(),
        size: stat?.size ?? 0,
        lastModified: stat?.mtimeMs ?? 0,
      };
      results.push(dirEntry);
      scanned++;
      if (scanned % 5 === 0) {
        // Report progress via the dedicated channel
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(onProgressChannel, scanned, fullPath);
        }
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }

  try {
    await walk(dirPath);
    return results;
  } finally {
    cancelledScans.delete(scanId);
  }
});

ipcMain.handle('fs:cancelScan', (_evt, scanId: string): void => {
  cancelledScans.add(scanId);
});

ipcMain.handle('fs:stat', async (_evt, p: string): Promise<FileInfo> => {
  try {
    const stat = await fs.promises.stat(p);
    return {
      path: p,
      size: stat.size,
      lastModified: stat.mtimeMs,
      isDirectory: stat.isDirectory(),
      isSymlink: stat.isSymbolicLink(),
      exists: true,
    };
  } catch {
    return { path: p, size: 0, lastModified: 0, isDirectory: false, isSymlink: false, exists: false };
  }
});

ipcMain.handle('fs:exists', async (_evt, p: string): Promise<boolean> => {
  try {
    await fs.promises.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('fs:createDir', async (_evt, p: string): Promise<{ success: boolean; error?: string }> => {
  try {
    await fs.promises.mkdir(p, { recursive: true });
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('fs:moveFile', async (_evt, source: string, dest: string): Promise<MoveResult> => {
  try {
    try {
      await fs.promises.access(dest, fs.constants.F_OK);
      return { success: false, error: 'فایل مقصد از قبل وجود دارد' };
    } catch {
      // destination does not exist
    }
    try {
      await fs.promises.rename(source, dest);
      return { success: true, destPath: dest };
    } catch {
      await fs.promises.copyFile(source, dest, fs.constants.COPYFILE_EXCL);
      try {
        await fs.promises.unlink(source);
      } catch (e) {
        return {
          success: false,
          error: `کپی انجام شد اما حذف فایل مبدأ ناموفق بود: ${e instanceof Error ? e.message : String(e)}`,
          destPath: dest,
        };
      }
      return { success: true, destPath: dest };
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('fs:writeTextFile', async (_evt, p: string, content: string): Promise<{ success: boolean; error?: string }> => {
  try {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, content, 'utf8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('fs:downloadFile', async (_evt, url: string, destPath: string): Promise<{ success: boolean; error?: string }> => {
  try {
    const response = await fetch(url);
    if (!response.ok) return { success: false, error: `دانلود ناموفق: ${response.status}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.writeFile(destPath, buffer);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('fs:isSymlink', async (_evt, p: string): Promise<boolean> => {
  try {
    const stat = await fs.promises.lstat(p);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
});

ipcMain.handle('fs:normalizePath', async (_evt, p: string): Promise<string> => {
  return path.resolve(p).replace(/\//g, '\\');
});

ipcMain.handle('fs:joinPath', async (_evt, ...segments: string[]): Promise<string> => {
  return path.join(...segments).replace(/\//g, '\\');
});

ipcMain.handle('fs:parentPath', async (_evt, p: string): Promise<string> => {
  return path.dirname(p).replace(/\//g, '\\');
});

ipcMain.handle('fs:baseName', async (_evt, p: string): Promise<string> => {
  return path.basename(p);
});



// Remove one strictly-empty child directory. Never recursive: rmdir only succeeds
// for an empty directory. The selected library root itself is never removable.
ipcMain.handle('fs:removeEmptyDirectory', async (_evt, targetPath: string, selectedRoot: string): Promise<{ success: boolean; error?: string }> => {
  try {
    if (typeof targetPath !== 'string' || typeof selectedRoot !== 'string' || !path.isAbsolute(targetPath) || !path.isAbsolute(selectedRoot)) {
      return { success: false, error: 'مسیر نامعتبر است' };
    }
    const root = path.resolve(selectedRoot);
    const target = path.resolve(targetPath);
    const relative = path.relative(root, target);
    if (!relative || relative === '.' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      return { success: false, error: 'فقط زیرپوشه‌های مسیر آرشیو قابل حذف هستند؛ پوشه اصلی محافظت می‌شود' };
    }
    const rootStat = await fs.promises.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { success: false, error: 'مسیر اصلی آرشیو پوشه معتبر و امنی نیست' };
    }
    const targetStat = await fs.promises.lstat(target);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      return { success: false, error: 'مسیر انتخاب‌شده پوشه عادی نیست یا پیوند نمادین است' };
    }
    const realRoot = await fs.promises.realpath(root);
    const realTarget = await fs.promises.realpath(target);
    const realRelative = path.relative(realRoot, realTarget);
    if (!realRelative || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
      return { success: false, error: 'مسیر واقعی پوشه خارج از آرشیو است' };
    }
    const entries = await fs.promises.readdir(target);
    if (entries.length !== 0) {
      return { success: false, error: 'پوشه دیگر خالی نیست؛ هیچ فایلی حذف نشد' };
    }
    // Re-check immediately before rmdir to reduce the scan/delete race window.
    const finalStat = await fs.promises.lstat(target);
    if (!finalStat.isDirectory() || finalStat.isSymbolicLink() || (await fs.promises.readdir(target)).length !== 0) {
      return { success: false, error: 'وضعیت پوشه تغییر کرده است؛ عملیات لغو شد' };
    }
    await fs.promises.rmdir(target);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// --- IPC: Player discovery ---

ipcMain.handle('player:detect', async (): Promise<DetectedPlayer[]> => {
  return detectWindowsPlayers();
});

ipcMain.handle('player:validateExe', async (_evt, exePath: string): Promise<{ valid: boolean; error?: string }> => {
  return validateExecutable(exePath);
});

ipcMain.handle('player:browseExe', async (): Promise<string | null> => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'انتخاب پخش‌کننده ویدئو',
    filters: [{ name: 'برنامه‌های اجرایی', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('fs:browseFolders', async (): Promise<string[]> => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'انتخاب پوشه‌های کتابخانه',
    properties: ['openDirectory', 'multiSelections', 'createDirectory'],
  });
  return result.canceled ? [] : result.filePaths;
});

// --- IPC: OS-encrypted settings ---
const secureSettingsPath = (): string => path.join(app.getPath('userData'), 'secure-settings.json');

function readSecureSettings(): Record<string, string> {
  try {
    const raw = fs.readFileSync(secureSettingsPath(), 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeSecureSettings(settings: Record<string, string>): void {
  fs.mkdirSync(path.dirname(secureSettingsPath()), { recursive: true });
  fs.writeFileSync(secureSettingsPath(), JSON.stringify(settings), { mode: 0o600 });
}

ipcMain.handle('secure:set', async (_evt, key: string, value: string): Promise<void> => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('ویندوز ذخیره‌سازی امن را در دسترس قرار نداده است');
  const settings = readSecureSettings();
  settings[key] = safeStorage.encryptString(value).toString('base64');
  writeSecureSettings(settings);
});

ipcMain.handle('secure:get', async (_evt, key: string): Promise<string | null> => {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const encoded = readSecureSettings()[key];
  if (!encoded) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return null;
  }
});

// --- IPC: Playback ---

ipcMain.handle('playback:playFile', async (
  _evt,
  filePath: string,
  playerExecutable: string,
  subtitlePath?: string,
): Promise<PlaybackResult> => {
  return launchPlayer(filePath, playerExecutable, subtitlePath);
});

ipcMain.handle('playback:playSystemDefault', async (_evt, filePath: string): Promise<PlaybackResult> => {
  return launchSystemDefault(filePath);
});

// --- Player detection logic ---

function detectWindowsPlayers(): DetectedPlayer[] {
  const players: DetectedPlayer[] = [];
  const seen = new Set<string>();

  // System default handler
  players.push({
    id: 'system-default',
    name: 'پخش‌کننده پیش‌فرض ویندوز',
    executablePath: 'system-default',
    isSystemDefault: true,
    supportsSubtitles: true,
  });
  seen.add('system-default');

  // Known player registry: App Paths registry keys + known install locations.
  // We query these locations rather than scanning the drive.
  const knownPlayers: Array<{ id: string; name: string; registryKey: string; exeName: string }> = [
    { id: 'vlc', name: 'VLC media player', registryKey: 'vlc', exeName: 'vlc.exe' },
    { id: 'mpc-hc', name: 'Media Player Classic - Home Cinema', registryKey: 'mpc-hc64', exeName: 'mpc-hc64.exe' },
    { id: 'mpc-be', name: 'Media Player Classic - Black Edition', registryKey: 'mpc-be64', exeName: 'mpc-be64.exe' },
    { id: 'potplayer', name: 'PotPlayer', registryKey: 'PotPlayer64', exeName: 'PotPlayerMini64.exe' },
    { id: 'kmp', name: 'KMPlayer', registryKey: 'KMPlayer', exeName: 'KMPlayer.exe' },
    { id: 'gom', name: 'GOM Player', registryKey: 'GOM Player', exeName: 'GOM.exe' },
    { id: 'bsplayer', name: 'BS.Player', registryKey: 'BSplayer', exeName: 'bsplayer.exe' },
    { id: 'mpv', name: 'mpv', registryKey: '', exeName: 'mpv.exe' },
    { id: 'cyberlink-powerdvd', name: 'PowerDVD', registryKey: 'PowerDVD', exeName: 'PowerDVD.exe' },
    { id: 'windows-media-player', name: 'Windows Media Player', registryKey: '', exeName: 'wmplayer.exe' },
  ];

  // Check HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths
  // and HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths
  for (const kp of knownPlayers) {
    if (seen.has(kp.id)) continue;

    const exePath = findViaAppPaths(kp.exeName, kp.registryKey) || findViaKnownLocations(kp.exeName);
    if (exePath) {
      const isValid = fs.existsSync(exePath) && exePath.toLowerCase().endsWith('.exe');
      if (isValid) {
        players.push({
          id: kp.id,
          name: kp.name,
          executablePath: exePath,
          isSystemDefault: false,
          supportsSubtitles: playerSupportsSubtitles(kp.id),
        });
        seen.add(kp.id);
      }
    }
  }

  return players;
}

function findViaAppPaths(exeName: string, appPathKey: string): string | null {
  if (process.platform !== 'win32') return null;

  // Use reg.exe to query App Paths registry (avoids native regedit module dependency)
  const keys = [
    appPathKey ? `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${appPathKey}.exe` : '',
    `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
  ].filter(Boolean);

  for (const key of keys) {
    for (const hive of ['HKLM', 'HKCU']) {
      try {
        const result = execSync(`reg query "${hive}\\${key}" /ve 2>nul`);
        const match = /REG_SZ\s+(.+)/.exec(result.toString());
        if (match) {
          let p = match[1].trim();
          // Remove surrounding quotes
          p = p.replace(/^"|"$/g, '');
          if (p) return p;
        }
      } catch {
        // reg query failed — key doesn't exist
      }
    }
  }
  return null;
}

function findViaKnownLocations(exeName: string): string | null {
  if (process.platform !== 'win32') return null;

  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');

  const searchDirs = [
    path.join(programFiles, 'VideoLAN', 'VLC'),
    path.join(programFiles86, 'VideoLAN', 'VLC'),
    path.join(programFiles, 'K-Lite Codec Pack', 'MPC-HC'),
    path.join(programFiles86, 'K-Lite Codec Pack', 'MPC-HC'),
    path.join(programFiles, 'K-Lite Codec Pack', 'MPC-HC64'),
    path.join(programFiles86, 'K-Lite Codec Pack', 'MPC-HC64'),
    path.join(programFiles, 'Daum', 'PotPlayer'),
    path.join(programFiles86, 'Daum', 'PotPlayer'),
    path.join(programFiles, 'KMP'),
    path.join(programFiles86, 'KMP'),
    path.join(programFiles, 'GRETECH', 'GomPlayer'),
    path.join(programFiles86, 'GRETECH', 'GomPlayer'),
    path.join(programFiles, 'Windows Media Player'),
    path.join(localAppData, 'Programs', 'mpv'),
    path.join(programFiles, 'mpv'),
    path.join(programFiles86, 'mpv'),
  ];

  for (const dir of searchDirs) {
    const candidate = path.join(dir, exeName);
    if (fs.existsSync(candidate)) return candidate;
  }

  // Also check if it's directly on the PATH
  try {
    const result = execSync(`where "${exeName}" 2>nul`);
    const lines = result.toString().split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) return lines[0];
  } catch {
    // not on PATH
  }

  return null;
}

function playerSupportsSubtitles(playerId: string): boolean {
  const supported = new Set(['vlc', 'mpc-hc', 'mpc-be', 'mpv', 'potplayer', 'kmp', 'bsplayer']);
  return supported.has(playerId);
}

function validateExecutable(exePath: string): { valid: boolean; error?: string } {
  if (!exePath || !exePath.toLowerCase().endsWith('.exe')) {
    return { valid: false, error: 'فایل انتخابی یک فایل اجرایی (.exe) نیست' };
  }
  try {
    fs.accessSync(exePath, fs.constants.F_OK | fs.constants.X_OK);
    return { valid: true };
  } catch {
    return { valid: false, error: 'فایل اجرایی یافت نشد یا قابل اجرا نیست' };
  }
}

function launchPlayer(
  filePath: string,
  playerExecutable: string,
  subtitlePath?: string,
): PlaybackResult {
  try {
    // Verify the media file exists before launching
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'فایل ویدئو یافت نشد. ممکن است درایو متصل نباشد یا فایل جابه‌جا شده باشد.' };
    }

    // Build argument array — NEVER use shell concatenation for untrusted paths
    const args: string[] = [filePath];

    // Subtitle switches are player-specific. Keep paths as separate argv items
    // so spaces and non-Latin characters are passed safely to the player.
    if (subtitlePath && fs.existsSync(subtitlePath)) {
      const playerId = path.basename(playerExecutable).toLowerCase();
      if (playerId === 'kmplayer.exe' || playerExecutable.toLowerCase().includes('kmplayer')) {
        args.push('/sub', subtitlePath);
      } else if (playerId === 'potplayermini64.exe' || playerExecutable.toLowerCase().includes('potplayer')) {
        args.push('/sub', subtitlePath);
      } else if (playerId === 'mpc-hc64.exe' || playerId === 'mpc-be64.exe' || playerExecutable.toLowerCase().includes('mpc-hc') || playerExecutable.toLowerCase().includes('mpc-be')) {
        args.push('/sub', subtitlePath);
      } else if (playerId === 'mpv.exe' || playerExecutable.toLowerCase().includes('mpv')) {
        args.push(`--sub-file=${subtitlePath}`);
      } else if (playerId === 'vlc.exe' || playerExecutable.toLowerCase().includes('vlc')) {
        args.push('--sub-file', subtitlePath);
      } else {
        // Unknown players still receive the video; don't send an unsupported switch.
      }
    }

    // spawn() with explicit args array — no shell interpolation
    const child = spawn(playerExecutable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();

    return {
      success: true,
      playerUsed: playerExecutable,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'خطا در اجرای پخش‌کننده',
    };
  }
}

function launchSystemDefault(filePath: string): PlaybackResult {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'فایل ویدئو یافت نشد. ممکن است درایو متصل نباشد یا فایل جابه‌جا شده باشد.' };
    }

    // Use the Windows "start" command via spawn with no shell
    // `start "" "path"` opens with the default handler
    const child = spawn('cmd.exe', ['/c', 'start', '""', filePath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();

    return { success: true, playerUsed: 'system-default' };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'خطا در اجرای پخش با برنامه پیش‌فرض ویندوز',
    };
  }
}

// Helper: synchronous exec for registry queries (only used in detectWindowsPlayers)
function execSync(command: string): Buffer {
  return nodeExecSync(command, { timeout: 3000 });
}
