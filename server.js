'use strict';
// 계약서 관리 웹앱 서버: 구글 시트/드라이브 읽기(서비스계정) + 비밀번호 + 정적 화면
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = process.env;
const PORT = +env.PORT || 3000;
const PASSWORD = env.APP_PASSWORD || '';
const SECRET = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SHEET_ID = env.SHEET_ID || '';
const SHEET_TAB = env.SHEET_TAB || '계약기간';
const DRIVE_FOLDER_ID = env.DRIVE_FOLDER_ID || '';
const OUTPUT_FOLDER_ID = env.OUTPUT_FOLDER_ID || '';   // 비우면 계약서 폴더 안에 '작업완료' 폴더를 만들어 씁니다
const MOCK = env.MOCK === '1';                         // 구글 없이 로컬 파일로 화면 테스트
const MOCK_SHEET = env.MOCK_SHEET || '';
const MOCK_DIR = env.MOCK_DIR || '';
const MOCK_OUT = env.MOCK_OUT || path.join(__dirname, 'mock_out');
const PUB = path.join(__dirname, 'public');

if (!PASSWORD) { console.error('APP_PASSWORD 환경변수(접속 비밀번호)를 설정해 주세요.'); process.exit(1); }

// ---------- 구글 연결
let sheetsApi = null, driveApi = null;
function initGoogle() {
  if (MOCK) return;
  const { google } = require('googleapis');
  let creds;
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) creds = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  else if (env.GOOGLE_APPLICATION_CREDENTIALS) creds = JSON.parse(fs.readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
  else throw new Error('서비스계정 키가 없습니다. GOOGLE_SERVICE_ACCOUNT_JSON 또는 GOOGLE_APPLICATION_CREDENTIALS를 설정해 주세요.');
  if (!SHEET_ID || !DRIVE_FOLDER_ID) throw new Error('SHEET_ID, DRIVE_FOLDER_ID를 설정해 주세요.');
  const auth = new google.auth.JWT({
    email: creds.client_email, key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive']
  });
  sheetsApi = google.sheets({ version: 'v4', auth });
  driveApi = google.drive({ version: 'v3', auth });
}

// ---------- 로그인(비밀번호 하나, 서명된 쿠키)
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function makeToken() { const exp = Date.now() + 12 * 3600e3; return exp + '.' + sign(String(exp)); }
function validToken(t) {
  if (!t) return false; const i = t.indexOf('.'); if (i < 0) return false;
  const exp = t.slice(0, i); if (!(+exp > Date.now())) return false;
  return safeEq(t.slice(i + 1), sign(exp));
}
function cookies(req) { const o = {}; String(req.headers.cookie || '').split(/;\s*/).forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1)); }); return o; }
const fails = {}; // ip -> {n, until}
function ipOf(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }

// ---------- 데이터
async function getSheet() {
  if (MOCK) {
    const XLSX = require('xlsx');
    const wb = XLSX.read(fs.readFileSync(MOCK_SHEET, 'utf8'), { type: 'string', raw: true });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  }
  const r = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: "'" + SHEET_TAB.replace(/'/g, "''") + "'",
    valueRenderOption: 'FORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING'
  });
  const v = r.data.values || [];
  const w = v.reduce((m, a) => Math.max(m, a.length), 0);
  return v.map((a) => { const b = a.slice(); while (b.length < w) b.push(''); return b; });
}
let listCache = null;
async function listContracts() {
  if (MOCK) {
    const out = [];
    (function walk(d, rel) {
      fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(p, r); else if (/\.hwp$/i.test(e.name)) out.push({ id: Buffer.from(r).toString('base64url'), rel: r, size: fs.statSync(p).size });
      });
    })(MOCK_DIR, '');
    return out;
  }
  const out = [];
  async function walk(folderId, rel) {
    let pageToken;
    do {
      const r = await driveApi.files.list({
        q: "'" + folderId + "' in parents and trashed=false", pageSize: 1000, pageToken,
        fields: 'nextPageToken, files(id,name,mimeType,size,modifiedTime)', supportsAllDrives: true, includeItemsFromAllDrives: true
      });
      for (const f of r.data.files || []) {
        const rp = rel ? rel + '/' + f.name : f.name;
        if (f.mimeType === 'application/vnd.google-apps.folder') { if (f.name !== '작업완료') await walk(f.id, rp); }
        else if (/\.hwp$/i.test(f.name)) out.push({ id: f.id, rel: rp, size: +f.size || 0, modified: f.modifiedTime });
      }
      pageToken = r.data.nextPageToken;
    } while (pageToken);
  }
  await walk(DRIVE_FOLDER_ID, '');
  return out;
}
async function getFile(id) {
  if (MOCK) {
    const rel = Buffer.from(id, 'base64url').toString();
    if (rel.includes('..')) throw new Error('bad id');
    return fs.readFileSync(path.join(MOCK_DIR, rel));
  }
  const r = await driveApi.files.get({ fileId: id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  return Buffer.from(r.data);
}
let outFolder = OUTPUT_FOLDER_ID;
async function ensureOut() {
  if (outFolder) return outFolder;
  const r = await driveApi.files.list({
    q: "'" + DRIVE_FOLDER_ID + "' in parents and trashed=false and name='작업완료' and mimeType='application/vnd.google-apps.folder'",
    fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true
  });
  if (r.data.files && r.data.files.length) return (outFolder = r.data.files[0].id);
  const c = await driveApi.files.create({
    requestBody: { name: '작업완료', mimeType: 'application/vnd.google-apps.folder', parents: [DRIVE_FOLDER_ID] },
    fields: 'id', supportsAllDrives: true
  });
  return (outFolder = c.data.id);
}
async function saveFile(name, buf) {
  if (MOCK) { fs.mkdirSync(MOCK_OUT, { recursive: true }); fs.writeFileSync(path.join(MOCK_OUT, path.basename(name)), buf); return { id: 'mock', name }; }
  const { Readable } = require('stream');
  const parent = await ensureOut();
  const r = await driveApi.files.create({
    requestBody: { name, parents: [parent] },
    media: { mimeType: 'application/octet-stream', body: Readable.from(buf) },
    fields: 'id,name', supportsAllDrives: true
  });
  return r.data;
}

// ---------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, max) {
  return new Promise((ok, no) => {
    const a = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { no(new Error('too large')); req.destroy(); } else a.push(c); });
    req.on('end', () => ok(Buffer.concat(a)));
    req.on('error', no);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (p === '/api/login' && req.method === 'POST') {
      const ip = ipOf(req), f = fails[ip] || { n: 0, until: 0 };
      if (f.until > Date.now()) return send(res, 429, { error: '잠시 후 다시 시도해 주세요.' });
      const b = JSON.parse((await readBody(req, 4096)).toString() || '{}');
      if (safeEq(String(b.password || ''), PASSWORD)) {
        delete fails[ip];
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.setHeader('Set-Cookie', 'sid=' + makeToken() + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200' + secure);
        return send(res, 200, { ok: true });
      }
      f.n++; if (f.n >= 5) { f.until = Date.now() + 60e3; f.n = 0; } fails[ip] = f;
      return send(res, 401, { error: '비밀번호가 맞지 않습니다.' });
    }
    if (p === '/api/logout') { res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0'); return send(res, 200, { ok: true }); }
    if (p.startsWith('/api/')) {
      if (!validToken(cookies(req).sid)) return send(res, 401, { error: 'login' });
      if (p === '/api/me') return send(res, 200, { ok: true, mock: MOCK });
      if (p === '/api/sheet') return send(res, 200, { values: await getSheet() });
      if (p === '/api/contracts') { listCache = await listContracts(); return send(res, 200, { files: listCache }); }
      if (p === '/api/file') {
        const id = u.searchParams.get('id') || '';
        if (!/^[\w-]+$/.test(id)) return send(res, 400, { error: 'bad id' });
        return send(res, 200, await getFile(id), 'application/octet-stream');
      }
      if (p === '/api/save' && req.method === 'POST') {
        const name = (u.searchParams.get('name') || '').replace(/[\\/]/g, '_');
        if (!name) return send(res, 400, { error: 'name' });
        return send(res, 200, await saveFile(name, await readBody(req, 40e6)));
      }
      return send(res, 404, { error: 'not found' });
    }
    // 정적 파일
    let f = p === '/' ? '/index.html' : p;
    const full = path.join(PUB, path.normalize(f).replace(/^(\.\.[\/\\])+/, ''));
    if (!full.startsWith(PUB) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e.message || e) });
  }
});

try { initGoogle(); } catch (e) { console.error(e.message); process.exit(1); }
server.listen(PORT, () => console.log('계약서 관리 서버 시작: http://localhost:' + PORT + (MOCK ? ' (테스트 모드)' : '')));
