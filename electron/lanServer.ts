import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export interface LanRoot {
  id: string;
  name: string;
  path: string;
}
export interface LanServerStatus {
  running: boolean;
  port: number;
  pin: string;
  addresses: string[];
  roots: Array<{ id: string; name: string }>;
}
type RootEntry = LanRoot & { path: string };

let server: http.Server | null = null;
let currentStatus: LanServerStatus = { running: false, port: 47821, pin: '', addresses: [], roots: [] };
let accessToken = '';

const PORT = 47821;
const VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ts': 'video/mp2t',
};
const SUBTITLE_MIME: Record<string, string> = {
  '.srt': 'application/x-subrip', '.ass': 'text/plain; charset=utf-8',
  '.ssa': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8',
  '.sub': 'text/plain; charset=utf-8', '.smi': 'application/smil; charset=utf-8',
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition',
};

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS });
  res.end(JSON.stringify(data));
}
function isAuthorized(req: http.IncomingMessage, url: URL): boolean {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\\s+/i, '');
  const supplied = bearer || url.searchParams.get('accessToken') || '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(accessToken);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
function findRoot(roots: RootEntry[], id: string | null): RootEntry {
  const root = roots.find((item) => item.id === id);
  if (!root) throw new Error('پوشه اشتراکی پیدا نشد');
  return root;
}
function resolveSafe(root: RootEntry, relative: string | null): string {
  const target = path.resolve(root.path, relative || '.');
  const rel = path.relative(root.path, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('مسیر خارج از پوشه مجاز است');
  const realRoot = fs.realpathSync(root.path);
  const realTarget = fs.realpathSync(target);
  const realRel = path.relative(realRoot, realTarget);
  if (realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) throw new Error('مسیر پیوندی خارج از پوشه مجاز است');
  return realTarget;
}
function sidecars(root: RootEntry, video: string) {
  const stem = path.basename(video, path.extname(video)).toLocaleLowerCase();
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(path.dirname(video), { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    if (!entry.isFile()) return [];
    const ext = path.extname(entry.name).toLowerCase();
    if (!SUBTITLE_MIME[ext]) return [];
    const subtitleStem = path.basename(entry.name, ext).toLocaleLowerCase();
    if (subtitleStem !== stem && !subtitleStem.startsWith(stem + '.')) return [];
    return [{
      name: entry.name,
      path: path.relative(root.path, path.join(path.dirname(video), entry.name)).split(path.sep).join('/'),
      language: /(^|\\.)(fa|fas|per|persian)(\\.|$)/i.test(subtitleStem) ? 'fa' : '',
    }];
  }).sort((a, b) => Number(b.language === 'fa') - Number(a.language === 'fa') || a.name.localeCompare(b.name));
}
function networkAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flat().filter((item): item is NonNullable<typeof item> =>
    Boolean(item && item.family === 'IPv4' && !item.internal)).map((item) => item.address);
}

export async function startLanServer(inputRoots: LanRoot[]): Promise<LanServerStatus> {
  await stopLanServer();
  if (!Array.isArray(inputRoots) || inputRoots.length === 0) throw new Error('حداقل یک پوشه کتابخانه را برای اشتراک انتخاب کن');
  const roots: RootEntry[] = [];
  for (const item of inputRoots) {
    if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.path !== 'string' || !path.isAbsolute(item.path)) {
      throw new Error('اطلاعات پوشه اشتراکی معتبر نیست');
    }
    const real = fs.realpathSync(item.path);
    const stat = fs.statSync(real);
    if (!stat.isDirectory()) throw new Error('مسیر اشتراک پوشه نیست: ' + item.name);
    roots.push({ id: item.id, name: item.name, path: real });
  }
  const pin = String(crypto.randomInt(100000, 1000000));
  accessToken = crypto.randomBytes(32).toString('hex');

  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (url.pathname === '/pair' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); if (body.length > 2048) req.destroy(); });
      req.on('end', () => {
        try {
          const input = JSON.parse(body || '{}') as { pin?: string };
          if (String(input.pin || '') !== pin) { sendJson(res, 401, { error: 'کد اتصال اشتباه است' }); return; }
          sendJson(res, 200, { token: accessToken, device: 'FILM BAZ Desktop', version: appVersion() });
        } catch { sendJson(res, 400, { error: 'درخواست نامعتبر است' }); }
      });
      return;
    }
    if (!isAuthorized(req, url)) { sendJson(res, 401, { error: 'ابتدا دستگاه را جفت‌سازی کنید' }); return; }
    if (url.pathname === '/api/health' || url.pathname === '/api/info') { sendJson(res, 200, { ok: true, version: appVersion() }); return; }
    if (url.pathname === '/api/roots') { sendJson(res, 200, { roots: roots.map(({ id, name }) => ({ id, name })) }); return; }
    if (url.pathname === '/api/files') {
      try {
        const root = findRoot(roots, url.searchParams.get('rootId'));
        const target = resolveSafe(root, url.searchParams.get('path'));
        if (!fs.statSync(target).isDirectory()) { sendJson(res, 400, { error: 'مسیر پوشه نیست' }); return; }
        const entries = fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
          if (entry.isSymbolicLink()) return [];
          const full = path.join(target, entry.name);
          let stat: fs.Stats;
          try { stat = fs.statSync(full); } catch { return []; }
          const ext = path.extname(entry.name).toLowerCase();
          const mime = VIDEO_MIME[ext] || SUBTITLE_MIME[ext] || 'application/octet-stream';
          const relativePath = path.relative(root.path, full).split(path.sep).join('/');
          return [{
            name: entry.name, isDirectory: entry.isDirectory(), size: stat.size,
            modifiedAt: stat.mtimeMs, mime, path: relativePath,
            subtitles: entry.isFile() && VIDEO_MIME[ext] ? sidecars(root, full) : [],
          }];
        });
        sendJson(res, 200, { rootId: root.id, path: url.searchParams.get('path') || '', entries });
      } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (url.pathname === '/api/subtitle') {
      try {
        const root = findRoot(roots, url.searchParams.get('rootId'));
        const target = resolveSafe(root, url.searchParams.get('path'));
        const ext = path.extname(target).toLowerCase();
        const stat = fs.statSync(target);
        if (!stat.isFile() || !SUBTITLE_MIME[ext]) { sendJson(res, 403, { error: 'فقط فایل زیرنویس قابل دریافت است' }); return; }
        res.writeHead(200, { ...CORS, 'Content-Type': SUBTITLE_MIME[ext], 'Content-Length': stat.size,
          'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(path.basename(target)), 'Cache-Control': 'no-store' });
        fs.createReadStream(target).pipe(res);
      } catch (error) { sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (url.pathname === '/api/stream') {
      try {
        const root = findRoot(roots, url.searchParams.get('rootId'));
        const target = resolveSafe(root, url.searchParams.get('path'));
        const stat = fs.statSync(target);
        const ext = path.extname(target).toLowerCase();
        const type = VIDEO_MIME[ext];
        if (!stat.isFile() || !type) { sendJson(res, 403, { error: 'فقط فایل ویدئویی قابل پخش است' }); return; }
        res.setHeader('Content-Type', type);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-store');
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\\d*)-(\\d*)$/.exec(range);
          if (!match) { res.writeHead(416); res.end(); return; }
          const start = match[1] ? Number(match[1]) : 0;
          const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
          if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); res.end(); return; }
          res.writeHead(206, { ...CORS, 'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size, 'Content-Length': end - start + 1 });
          fs.createReadStream(target, { start, end }).pipe(res);
        } else {
          res.writeHead(200, { ...CORS, 'Content-Length': stat.size });
          fs.createReadStream(target).pipe(res);
        }
      } catch (error) { sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    sendJson(res, 404, { error: 'مسیر پیدا نشد' });
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(PORT, '0.0.0.0', () => { server!.removeListener('error', reject); resolve(); });
  });
  currentStatus = {
    running: true, port: PORT, pin, addresses: networkAddresses(),
    roots: roots.map(({ id, name }) => ({ id, name })),
  };
  return getLanServerStatus();
}

function appVersion(): string { return '1.1.0'; }

export async function stopLanServer(): Promise<void> {
  const active = server;
  server = null;
  accessToken = '';
  currentStatus = { running: false, port: PORT, pin: '', addresses: [], roots: [] };
  if (active) await new Promise<void>((resolve) => active.close(() => resolve()));
}
export function getLanServerStatus(): LanServerStatus {
  return { ...currentStatus, addresses: [...currentStatus.addresses], roots: [...currentStatus.roots] };
}
