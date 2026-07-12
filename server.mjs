// 实时后端：把浏览器的麦克风/摄像头流桥接到 Gemini Live（key 藏在这里，不进浏览器）。
// 浏览器 <-- WebSocket --> 本服务 <-- Gemini Live SDK --> Gemini
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality, Type } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读取 .env
(function loadDotenv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([\w.-]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || m[1].startsWith('#')) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
})();

const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';

// ===== 邮箱验证码登录（Supabase Auth OTP）+ BYOK 配置 =====
// 需要 SUPABASE_URL + SUPABASE_ANON_KEY + SESSION_SECRET 三者齐备才启用「邮箱验证码」模式；
// 缺任一则回退旧的邀请码登录（ACCESS_USERS），保证部署到缺变量的环境也不崩。
const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const APP_ENC_KEY = process.env.APP_ENC_KEY || '';
const EMAIL_AUTH = Boolean(process.env.SUPABASE_URL && ANON_KEY && SESSION_SECRET);
// owner 邮箱：无自带 key 时回落到全局 GEMINI_API_KEY（你自己不用粘 key，别人必须自带）
const OWNER_EMAILS = new Set(
  (process.env.OWNER_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

// 访问控制：每个测试用户一个邀请码（ACCESS_USERS="alice:码A,bob:码B"）。
// 兼容老配置：只设了 ACCESS_PASSWORD 时当作单用户「我」。本地都不设=不限制。
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
function parseUsers() {
  const map = new Map(); // token(=hash(码)) -> 用户名
  for (const pair of (process.env.ACCESS_USERS || '').split(',')) {
    const i = pair.indexOf(':');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const code = pair.slice(i + 1).trim();
    if (name && code) map.set(hash(code), name);
  }
  if (map.size === 0 && process.env.ACCESS_PASSWORD) map.set(hash(process.env.ACCESS_PASSWORD), '我');
  return map;
}
const TOKEN_TO_USER = parseUsers();
const AUTH_ON = TOKEN_TO_USER.size > 0;
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
// 「本机或局域网直连」（回环/私网地址且未经反向代理）时，允许 ?as= 写入的 rc_as 覆盖用户名，用来测新用户初次流程。
// 线上跑在 Render 反代后面（会带 x-forwarded-*），一律不认，杜绝被绕过登录。
function localDirect(req) {
  const ip = ((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  const loopback = ip === '::1' || ip === '127.0.0.1';
  const privateLan =
    /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip);
  return (loopback || privateLan) && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-proto'];
}
function devAs(req) {
  return localDirect(req) ? decodeURIComponent(parseCookies(req).rc_as || '') : '';
}
// 邮箱模式的会话 cookie：值 = base64url(邮箱).HMAC(邮箱)，防伪造（不能存明文邮箱，否则谁都能冒充）
function signSession(email) {
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(email).digest('base64url');
  return Buffer.from(email).toString('base64url') + '.' + mac;
}
function verifySession(cookie) {
  if (!cookie || cookie.indexOf('.') < 0) return '';
  const dot = cookie.lastIndexOf('.');
  const b64 = cookie.slice(0, dot);
  const mac = cookie.slice(dot + 1);
  let email;
  try {
    email = Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return '';
  }
  const good = crypto.createHmac('sha256', SESSION_SECRET).update(email).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return '';
  return email;
}

function isAuthed(req) {
  if (devAs(req)) return true; // 本机 ?as= 测试会话放行
  if (EMAIL_AUTH) return Boolean(verifySession(parseCookies(req).rc_auth || ''));
  if (!AUTH_ON) return true; // 没配用户 = 放行（本地开发）
  return TOKEN_TO_USER.has(parseCookies(req).rc_auth || '');
}
function getUser(req) {
  const as = devAs(req);
  if (as) return as; // 本机 ?as= 覆盖：测新用户用
  if (EMAIL_AUTH) return verifySession(parseCookies(req).rc_auth || '') || '匿名';
  if (!AUTH_ON) return '本机';
  return TOKEN_TO_USER.get(parseCookies(req).rc_auth || '') || '匿名';
}
// owner 判定：邮箱模式下用量看板/重置仅 owner 可见（用户名=邮箱，不能泄露给自助注册的人）。
// 非邮箱模式（invite/open）沿用旧行为，不限制。
function isOwnerReq(req) {
  if (!EMAIL_AUTH) return true;
  return OWNER_EMAILS.has(String(getUser(req)).toLowerCase());
}

const VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';

// ===== 用量统计（按用户累计，存 Supabase；没配 Supabase 则退回本地文件）=====
const RATES = { inText: 0.75, inAudio: 3, inVideo: 1, outText: 4.5, outAudio: 12 }; // $/百万 token
const emptyUsage = () => ({ inAudio: 0, inVideo: 0, inText: 0, outAudio: 0, outText: 0 });

// 持久层：优先 Supabase（Render 免费版硬盘会清零，必须存外部库），否则本地 JSON 文件
const supa =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
    : null;
// 邮箱验证码用 anon key（走 Supabase Auth 的 signInWithOtp / verifyOtp）
const supaAuth = EMAIL_AUTH
  ? createClient(process.env.SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
  : null;

// ===== BYOK：每个用户自带的 Gemini key，AES-256-GCM 加密存 Supabase =====
const ENC_KEY = APP_ENC_KEY ? crypto.createHash('sha256').update(APP_ENC_KEY).digest() : null;
function encSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function decSecret(blob) {
  try {
    const [iv, tag, ct] = String(blob).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}
const keyByUser = new Map(); // 邮箱 -> 解密后的 Gemini key（放内存里供调用）
async function loadSecrets() {
  if (!supa || !ENC_KEY) return;
  const { data, error } = await supa.from('user_secrets').select('*');
  if (error) return console.error('Supabase 读取用户密钥失败:', error.message);
  for (const r of data || []) {
    const k = decSecret(r.gemini_key_enc || '');
    if (k) keyByUser.set(r.username, k);
  }
  console.log(`用户密钥已从 Supabase 载入：${keyByUser.size} 个`);
}
loadSecrets();
async function setUserKey(name, key) {
  keyByUser.set(name, key);
  if (supa && ENC_KEY) {
    const { error } = await supa
      .from('user_secrets')
      .upsert({ username: name, gemini_key_enc: encSecret(key), updated_at: new Date().toISOString() }, { onConflict: 'username' });
    if (error) console.error('Supabase 写入用户密钥失败:', error.message);
  }
}
async function clearUserKey(name) {
  keyByUser.delete(name);
  if (supa) await supa.from('user_secrets').delete().eq('username', name);
}
// 该用户实际能用的 key：自己存的 > owner 回落全局；都没有则空（=还没配 key）
function keyFor(name) {
  return keyByUser.get(name) || (OWNER_EMAILS.has(String(name).toLowerCase()) ? KEY : '');
}
function hasKey(name) {
  return Boolean(keyFor(name));
}

const USAGE_FILE = path.join(__dirname, 'data', 'usage.json');

// 内存里按用户名持有用量；Supabase/文件是持久备份，会话结束时落库
const usageByUser = new Map();
function getUsage(name) {
  if (!usageByUser.has(name)) usageByUser.set(name, { ...emptyUsage(), streamingMs: 0, sessions: 0, startedAt: null });
  return usageByUser.get(name);
}
// JS 驼峰 <-> Postgres 蛇形 列名互转
function usageToRow(name, u) {
  return {
    username: name,
    in_text: u.inText, in_audio: u.inAudio, in_video: u.inVideo, out_text: u.outText, out_audio: u.outAudio,
    streaming_ms: u.streamingMs, sessions: u.sessions,
    started_at: u.startedAt ? new Date(u.startedAt).toISOString() : null,
    updated_at: new Date().toISOString(),
  };
}
function rowToUsage(r) {
  return {
    inText: Number(r.in_text) || 0, inAudio: Number(r.in_audio) || 0, inVideo: Number(r.in_video) || 0,
    outText: Number(r.out_text) || 0, outAudio: Number(r.out_audio) || 0,
    streamingMs: Number(r.streaming_ms) || 0, sessions: Number(r.sessions) || 0,
    startedAt: r.started_at ? new Date(r.started_at).getTime() : null,
  };
}
function saveLocal() {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(Object.fromEntries(usageByUser)));
  } catch {}
}
async function loadUsage() {
  if (supa) {
    const { data, error } = await supa.from('usage').select('*');
    if (error) return console.error('Supabase 读取失败:', error.message);
    for (const r of data || []) usageByUser.set(r.username, rowToUsage(r));
    console.log(`用量已从 Supabase 载入：${usageByUser.size} 个用户`);
  } else {
    try {
      if (fs.existsSync(USAGE_FILE))
        for (const [n, u] of Object.entries(JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')))) {
          if (u && typeof u === 'object') usageByUser.set(n, u); // 跳过旧的扁平格式（值是数字）
        }
    } catch {}
  }
}
async function flushUser(name) {
  if (!usageByUser.has(name)) return;
  if (supa) {
    const { error } = await supa.from('usage').upsert(usageToRow(name, getUsage(name)), { onConflict: 'username' });
    if (error) console.error('Supabase 写入失败:', error.message);
  } else {
    saveLocal();
  }
}
// accrue 每次 token 更新只改内存；攒一批每 15 秒落库一次（避免高频写库）
const dirtyUsers = new Set();
loadUsage();
setInterval(() => {
  for (const n of dirtyUsers) flushUser(n);
  dirtyUsers.clear();
}, 15000).unref?.();

// ===== 云端书库（按用户存一份书数组，换设备/清缓存也不丢；存 Supabase，没配则本地文件）=====
const libraryByUser = new Map();
const LIBRARY_FILE = path.join(__dirname, 'data', 'library.json');
function saveLibraryLocal() {
  try {
    fs.mkdirSync(path.dirname(LIBRARY_FILE), { recursive: true });
    fs.writeFileSync(LIBRARY_FILE, JSON.stringify(Object.fromEntries(libraryByUser)));
  } catch {}
}
async function loadLibrary() {
  if (supa) {
    const { data, error } = await supa.from('library').select('*');
    if (error) return console.error('Supabase 读取书库失败:', error.message);
    for (const r of data || []) libraryByUser.set(r.username, Array.isArray(r.books) ? r.books : []);
    console.log(`书库已从 Supabase 载入：${libraryByUser.size} 个用户`);
  } else {
    try {
      if (fs.existsSync(LIBRARY_FILE))
        for (const [n, books] of Object.entries(JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'))))
          if (Array.isArray(books)) libraryByUser.set(n, books);
    } catch {}
  }
}
async function flushLibrary(name) {
  const books = libraryByUser.get(name) || [];
  if (supa) {
    const { error } = await supa
      .from('library')
      .upsert({ username: name, books, updated_at: new Date().toISOString() }, { onConflict: 'username' });
    if (error) console.error('Supabase 写入书库失败:', error.message);
  } else {
    saveLibraryLocal();
  }
}
loadLibrary();

// ===== 读者画像（按用户存一份：onboarding 选的 seed + 隐式微调的 learned；存 Supabase，没配则本地文件）=====
const profileByUser = new Map();
const PROFILE_FILE = path.join(__dirname, 'data', 'profiles.json');
function saveProfilesLocal() {
  try {
    fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(Object.fromEntries(profileByUser)));
  } catch {}
}
async function loadProfiles() {
  if (supa) {
    const { data, error } = await supa.from('reader_profile').select('*');
    if (error) return console.error('Supabase 读取画像失败:', error.message);
    for (const r of data || []) profileByUser.set(r.username, { seed: r.seed || {}, learned: r.learned || {} });
    console.log(`读者画像已从 Supabase 载入：${profileByUser.size} 个用户`);
  } else {
    try {
      if (fs.existsSync(PROFILE_FILE))
        for (const [n, p] of Object.entries(JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'))))
          if (p && typeof p === 'object') profileByUser.set(n, { seed: p.seed || {}, learned: p.learned || {} });
    } catch {}
  }
}
async function flushProfile(name) {
  const p = profileByUser.get(name) || { seed: {}, learned: {} };
  if (supa) {
    const { error } = await supa
      .from('reader_profile')
      .upsert({ username: name, seed: p.seed || {}, learned: p.learned || {}, updated_at: new Date().toISOString() }, { onConflict: 'username' });
    if (error) console.error('Supabase 写入画像失败:', error.message);
  } else {
    saveProfilesLocal();
  }
}
loadProfiles();

// ===== 每本书的感想 + 进度（按用户存一个 {bookId:{reflections,progress}} blob；存 Supabase，没配则本地文件）=====
const memoryByUser = new Map();
const MEMORY_FILE = path.join(__dirname, 'data', 'book_memory.json');
function saveMemoryLocal() {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(Object.fromEntries(memoryByUser)));
  } catch {}
}
async function loadMemory() {
  if (supa) {
    const { data, error } = await supa.from('book_memory').select('*');
    if (error) return console.error('Supabase 读取书记忆失败:', error.message);
    for (const r of data || []) memoryByUser.set(r.username, r.data || {});
    console.log(`书记忆已从 Supabase 载入：${memoryByUser.size} 个用户`);
  } else {
    try {
      if (fs.existsSync(MEMORY_FILE))
        for (const [n, d] of Object.entries(JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')))) memoryByUser.set(n, d || {});
    } catch {}
  }
}
async function flushMemory(name) {
  const data = memoryByUser.get(name) || {};
  if (supa) {
    const { error } = await supa.from('book_memory').upsert({ username: name, data, updated_at: new Date().toISOString() }, { onConflict: 'username' });
    if (error) console.error('Supabase 写入书记忆失败:', error.message);
  } else {
    saveMemoryLocal();
  }
}
function bookMem(name, bookId) {
  if (!memoryByUser.has(name)) memoryByUser.set(name, {});
  const all = memoryByUser.get(name);
  if (!all[bookId]) all[bookId] = { reflections: [], progress: '' };
  return all[bookId];
}
loadMemory();

// 会话结束时把这一程的转写总结进书的「滚动进度」；太短就跳过，省一次 flash 调用
async function summarizeProgress(name, bookId, transcript) {
  const key = keyFor(name);
  if (!key || !bookId || !transcript.length) return;
  const text = transcript.map((t) => (t.role === 'in' ? '读者' : 'AI') + '：' + t.text).join('\n').trim();
  if (text.length < 80) return; // 太短，没啥可记
  const mem = bookMem(name, bookId);
  const prompt =
    '下面是读者精读一本英文书时、这一小段的语音转写。请用两三句中文更新「阅读进度」：读到书里哪儿、讲/聊了什么、读者卡住或特别在意的点；抓要点、别逐句复述。\n\n' +
    '已有进度：' + (mem.progress || '（还没有）') + '\n\n这一段转写：\n' + text + '\n\n只输出更新后的进度摘要本身。';
  try {
    const ai = new GoogleGenAI({ apiKey: key });
    const r = await ai.models.generateContent({ model: VISION_MODEL, contents: [{ role: 'user', parts: [{ text: prompt }] }] });
    const summary = (r.text || '').trim();
    if (summary) {
      mem.progress = summary;
      await flushMemory(name);
      console.log(`[进度·${bookId}] ${summary}`);
    }
  } catch (e) {
    console.error('进度总结失败:', e?.message || e);
  }
}

let usageLogged = false;
function extractBreakdown(meta) {
  const bd = emptyUsage();
  const ind = meta.promptTokensDetails || [];
  const outd = meta.responseTokensDetails || meta.candidatesTokensDetails || [];
  for (const d of ind) {
    const t = d.tokenCount || 0;
    const mod = (d.modality || '').toUpperCase();
    if (mod === 'AUDIO') bd.inAudio += t;
    else if (mod === 'VIDEO' || mod === 'IMAGE') bd.inVideo += t;
    else bd.inText += t;
  }
  for (const d of outd) {
    const t = d.tokenCount || 0;
    const mod = (d.modality || '').toUpperCase();
    if (mod === 'AUDIO') bd.outAudio += t;
    else bd.outText += t;
  }
  if (ind.length === 0 && meta.promptTokenCount) bd.inText += meta.promptTokenCount;
  if (outd.length === 0 && (meta.responseTokenCount || meta.candidatesTokenCount)) bd.outText += meta.responseTokenCount || meta.candidatesTokenCount || 0;
  return bd;
}
// usageMetadata 是「会话累计」，按增量加到该用户名下；cstate.last 记上次读数
function accrue(name, cstate, meta) {
  if (!usageLogged) {
    usageLogged = true;
    console.log('usageMetadata 样本:', JSON.stringify(meta));
  }
  const bd = extractBreakdown(meta);
  const u = getUsage(name);
  for (const k of Object.keys(emptyUsage())) u[k] += Math.max(0, (bd[k] || 0) - (cstate.last[k] || 0));
  cstate.last = bd;
  if (!u.startedAt) u.startedAt = Date.now();
  dirtyUsers.add(name);
}
function usageCost(u) {
  return (u.inText * RATES.inText + u.inAudio * RATES.inAudio + u.inVideo * RATES.inVideo + u.outText * RATES.outText + u.outAudio * RATES.outAudio) / 1e6;
}

const app = express();
app.set('trust proxy', 1); // 云端在反代后面，识别 https
app.use(express.json({ limit: '12mb' })); // 封面图片走 JSON body

// 开发便捷：本机直连时，访问 localhost/?as=test1 就切到一个全新空账号（写 rc_as cookie，之后所有接口/WS 都带上），
// ?as= 或 ?as=本机 恢复默认。放在门禁之前，并顺手改本次请求的 cookie，使首个 ?as 页面不被弹去登录页。线上（反代）忽略。
app.use((req, res, next) => {
  if (localDirect(req) && typeof req.query.as === 'string') {
    const name = req.query.as.trim();
    const rest = (req.headers.cookie || '').split(';').filter((p) => !p.trim().startsWith('rc_as='));
    if (!name || name === '本机') {
      res.setHeader('Set-Cookie', 'rc_as=; Path=/; Max-Age=0; SameSite=Lax');
      req.headers.cookie = rest.join(';');
    } else {
      const v = encodeURIComponent(name);
      res.setHeader('Set-Cookie', `rc_as=${v}; Path=/; Max-Age=2592000; SameSite=Lax`);
      req.headers.cookie = [...rest, ` rc_as=${v}`].join(';').replace(/^;\s*/, '');
    }
  }
  next();
});

// 登录页与校验（在门禁之前注册，未登录也能访问）
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'web', 'login.html')));
app.post('/login', (req, res) => {
  const token = hash((req.body && req.body.password) || '');
  if (TOKEN_TO_USER.has(token)) {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `rc_auth=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${secure}`);
    return res.json({ ok: true, user: TOKEN_TO_USER.get(token) });
  }
  res.status(401).json({ ok: false });
});

// 邮箱验证码登录：请求验证码 → 校验 → 设签名会话 cookie（邮箱模式启用时才有效）
app.post('/auth/request', async (req, res) => {
  if (!EMAIL_AUTH) return res.status(400).json({ ok: false, error: '未启用邮箱登录' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: '邮箱格式不对' });
  const { error } = await supaAuth.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) return res.status(429).json({ ok: false, error: error.message || '发送失败，请稍后再试' });
  res.json({ ok: true });
});
app.post('/auth/verify', async (req, res) => {
  if (!EMAIL_AUTH) return res.status(400).json({ ok: false, error: '未启用邮箱登录' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  const { data, error } = await supaAuth.auth.verifyOtp({ email, token: code, type: 'email' });
  if (error || !data?.user) return res.status(401).json({ ok: false, error: '验证码错误或已过期' });
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `rc_auth=${signSession(email)}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${secure}`);
  if (supa)
    supa
      .from('accounts')
      .upsert({ username: email, last_seen: new Date().toISOString() }, { onConflict: 'username' })
      .then(() => {}, () => {});
  res.json({ ok: true, email });
});
app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'rc_auth=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

// 登录模式 / 就绪状态：门禁之前公开，登录页据此切换「邮箱验证码 / 邀请码」界面
app.get('/status', (req, res) =>
  res.json({ ready: Boolean(KEY), model: MODEL, authMode: EMAIL_AUTH ? 'email' : AUTH_ON ? 'invite' : 'open' })
);

// 门禁：未登录的，网页跳登录页，接口返回 401
app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if ((req.headers.accept || '').includes('text/html')) return res.redirect('/login');
  res.status(401).json({ error: 'unauthorized' });
});

// no-cache：开发/迭代期保证手机和浏览器永远拿最新前端，避免「改了看不到」
app.use(express.static(path.join(__dirname, 'web'), { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));

// 当前登录者 + 是否已配 key（前端据此决定要不要挡在「填 key」页）
app.get('/me', (req, res) => {
  const email = getUser(req);
  res.json({
    ok: true,
    email,
    hasKey: hasKey(email),
    isOwner: OWNER_EMAILS.has(String(email).toLowerCase()),
    byokRequired: EMAIL_AUTH, // 邮箱模式下没 key 不让用
    authMode: EMAIL_AUTH ? 'email' : AUTH_ON ? 'invite' : 'open',
  });
});
// 设置 / 清除自己的 Gemini key。存前做一次极小调用校验，避免存进坏 key
app.put('/key', async (req, res) => {
  const email = getUser(req);
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ ok: false, error: 'key 为空' });
  try {
    const ai = new GoogleGenAI({ apiKey: key });
    await ai.models.generateContent({ model: VISION_MODEL, contents: [{ role: 'user', parts: [{ text: 'ping' }] }] });
  } catch (e) {
    return res.status(400).json({ ok: false, error: '这个 key 用不了：' + (e?.message || String(e)) });
  }
  await setUserKey(email, key);
  res.json({ ok: true });
});
app.delete('/key', async (req, res) => {
  await clearUserKey(getUser(req));
  res.json({ ok: true });
});

// 一次性识别封面：图片 -> 书名/作者/背景 JSON
app.post('/identify', async (req, res) => {
  const key = keyFor(getUser(req));
  if (!key) return res.json({ ok: false, error: '请先在设置里填入你的 Gemini API key' });
  const image = req.body?.image;
  if (!image) return res.json({ ok: false, error: '没有图像' });
  try {
    const ai = new GoogleGenAI({ apiKey: key });
    const prompt =
      '这是一本书的封面照片。先用 Google 搜索查一下这本书（作者、年代、主题、评价、核心思想），' +
      '然后仅用 JSON 回复（JSON 之外不要任何文字）：' +
      '{"title":"书名","author":"作者","language":"主要语言","summary":"两三句话内容简介",' +
      '"background":"结合联网查到的信息：作者背景、写作年代、主题、思想流派、对阅读有帮助的要点，可较详细","keyConcepts":["关键概念1","关键概念2"]}。' +
      '无法确定的项给空字符串或空数组。';
    const r = await ai.models.generateContent({
      model: VISION_MODEL,
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: image } }, { text: prompt }] }],
      config: { tools: [{ googleSearch: {} }] }, // 联网查这本书，背景卡更准
    });
    const raw = r.text || '';
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    res.json({ ok: true, data: json });
  } catch (e) {
    res.json({ ok: false, error: e?.message || String(e) });
  }
});

// 云端书库：按登录用户读/写自己的书（换设备、清缓存都还在）
app.get('/books', (req, res) => {
  res.json({ ok: true, user: getUser(req), books: libraryByUser.get(getUser(req)) || [] });
});
app.put('/books', async (req, res) => {
  const user = getUser(req);
  const books = Array.isArray(req.body?.books) ? req.body.books : [];
  libraryByUser.set(user, books);
  await flushLibrary(user);
  res.json({ ok: true, count: books.length });
});

// 读者画像：seed 由 onboarding 写；learned 预留给隐式微调，PUT 不动它
app.get('/profile', (req, res) => {
  const p = profileByUser.get(getUser(req)) || { seed: {}, learned: {} };
  res.json({ ok: true, user: getUser(req), seed: p.seed || {}, learned: p.learned || {} });
});
app.put('/profile', async (req, res) => {
  const user = getUser(req);
  const seed = req.body?.seed && typeof req.body.seed === 'object' ? req.body.seed : {};
  const prev = profileByUser.get(user) || { seed: {}, learned: {} };
  profileByUser.set(user, { seed, learned: prev.learned || {} });
  await flushProfile(user);
  res.json({ ok: true });
});

// 每本书的感想 + 进度：进书时拉进度注入 systemInstruction；感想列表供回看
app.get('/memory', (req, res) => {
  const all = memoryByUser.get(getUser(req)) || {};
  const book = req.query.book;
  if (book) return res.json({ ok: true, ...(all[book] || { reflections: [], progress: '' }) });
  res.json({ ok: true, books: all });
});

// 用量看板数据（邮箱模式下仅 owner 可见，避免泄露其他用户邮箱/用量）
app.get('/usage', (req, res) => {
  if (!isOwnerReq(req)) return res.status(403).json({ error: 'forbidden' });
  const withCost = (u) => {
    const cost = usageCost(u);
    const hours = u.streamingMs / 3600000;
    return { ...u, cost, perHour: hours > 0 ? cost / hours : 0 };
  };
  const users = [...usageByUser.entries()]
    .map(([username, u]) => ({ username, ...withCost(u) }))
    .sort((a, b) => b.cost - a.cost);
  // 合计：各项 token 相加后再算价
  const total = { ...emptyUsage(), streamingMs: 0, sessions: 0, startedAt: null };
  for (const u of usageByUser.values()) {
    for (const k of Object.keys(emptyUsage())) total[k] += u[k] || 0;
    total.streamingMs += u.streamingMs || 0;
    total.sessions += u.sessions || 0;
  }
  res.json({ users, total: { username: '合计', ...withCost(total) }, rates: RATES, liveModel: MODEL });
});
app.post('/usage/reset', async (req, res) => {
  if (!isOwnerReq(req)) return res.status(403).json({ error: 'forbidden' });
  const user = req.body?.user;
  if (user) {
    usageByUser.delete(user);
    dirtyUsers.delete(user);
    if (supa) await supa.from('usage').delete().eq('username', user);
  } else {
    usageByUser.clear();
    dirtyUsers.clear();
    usageLogged = false;
    if (supa) await supa.from('usage').delete().neq('username', '');
    else saveLocal();
  }
  res.json({ ok: true });
});
app.get('/dashboard', (req, res) => {
  if (!isOwnerReq(req)) return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, 'web', 'dashboard.html'));
});

// 有证书就用 HTTPS（手机调摄像头/麦克风必须是安全上下文），否则退回 HTTP（仅 Mac localhost 可用）
const certDir = path.join(__dirname, 'certs');
const haveCerts = fs.existsSync(path.join(certDir, 'cert.pem')) && fs.existsSync(path.join(certDir, 'key.pem'));
const server = haveCerts
  ? https.createServer(
      { cert: fs.readFileSync(path.join(certDir, 'cert.pem')), key: fs.readFileSync(path.join(certDir, 'key.pem')) },
      app
    )
  : http.createServer(app);
const wss = new WebSocketServer({ server, path: '/live', verifyClient: (info, cb) => cb(isAuthed(info.req)) });

wss.on('connection', (browser, req) => {
  let session = null;
  const user = getUser(req); // 这条连接属于哪个测试用户，用量都记到他名下
  const cstate = { last: emptyUsage(), streamStart: 0, transcript: [], bookId: '' };
  const send = (obj) => browser.readyState === 1 && browser.send(JSON.stringify(obj));

  browser.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'start') {
      const key = keyFor(user);
      if (!key) return send({ type: 'error', error: '请先在设置里填入你的 Gemini API key' });
      if (session) {
        try {
          session.close();
        } catch {}
        session = null;
      }
      if (cstate.streamStart) getUsage(user).streamingMs += Date.now() - cstate.streamStart;
      cstate.last = emptyUsage();
      cstate.streamStart = Date.now();
      getUsage(user).sessions += 1;
      dirtyUsers.add(user);
      cstate.bookId = msg.bookId || cstate.bookId; // 这一程属于哪本书（感想/进度记到它名下）
      cstate.transcript = []; // 每次唤醒开一段新转写
      const ai = new GoogleGenAI({ apiKey: key });
      const openSession = (handle) =>
        ai.live.connect({
          model: MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            mediaResolution: 'MEDIA_RESOLUTION_HIGH', // 显式钉高清晰度：读书要认清单词/指尖，别吃 Google 默认（会降到 LOW≈64token/帧）
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } }, // 钉死默认嗓「Zephyr」（女声/明亮），防模型更新后被换掉
            systemInstruction: msg.system || '',
            sessionResumption: handle ? { handle } : {}, // 开启会话续传
            contextWindowCompression: { slidingWindow: {} }, // 压缩上下文以延长会话
            inputAudioTranscription: {}, // 转写读者语音→文字（进度摘要要用；成本按 text token 计，已进用量看板）
            outputAudioTranscription: {}, // 转写 AI 语音→文字（进度摘要要用）
            tools: [
              {
                functionDeclarations: [
                  {
                    name: 'saveNote',
                    description: '记一笔：把读者读书时形成的一个想法/读后感，记进当前这本书的笔记',
                    parameters: {
                      type: Type.OBJECT,
                      properties: { note: { type: Type.STRING, description: '要记下来的那条想法（你俩讨论后成型的版本）' } },
                      required: ['note'],
                    },
                  },
                ],
              },
            ],
          },
          callbacks: {
            onopen: () => send({ type: 'open' }),
            onmessage: (m) => {
              const sc = m.serverContent;
              if (sc?.modelTurn?.parts) {
                for (const part of sc.modelTurn.parts) {
                  if (part.inlineData?.data) send({ type: 'audio', data: part.inlineData.data });
                }
              }
              // 转写回显：先看质量（中英混说准不准），暂不落库
              if (sc?.inputTranscription?.text) {
                const t = sc.inputTranscription.text;
                console.log(`[转写·读者] ${t}`);
                send({ type: 'transcript', role: 'in', text: t });
                cstate.transcript.push({ role: 'in', text: t });
              }
              if (sc?.outputTranscription?.text) {
                const t = sc.outputTranscription.text;
                console.log(`[转写·AI] ${t}`);
                send({ type: 'transcript', role: 'out', text: t });
                cstate.transcript.push({ role: 'out', text: t });
              }
              if (sc?.interrupted) send({ type: 'interrupted' });
              if (sc?.turnComplete) send({ type: 'turnComplete' });
              if (m.sessionResumptionUpdate?.newHandle) send({ type: 'resumeHandle', handle: m.sessionResumptionUpdate.newHandle });
              if (m.goAway) send({ type: 'goAway', timeLeft: m.goAway?.timeLeft });
              if (m.usageMetadata) accrue(user, cstate, m.usageMetadata);
              if (m.toolCall?.functionCalls?.length) {
                for (const fc of m.toolCall.functionCalls) {
                  if (fc.name === 'saveNote' && cstate.bookId) {
                    const note = String(fc.args?.note || '').trim();
                    if (note) {
                      bookMem(user, cstate.bookId).reflections.push({ text: note, at: Date.now() });
                      flushMemory(user); // 存进这本书的想法笔记
                      send({ type: 'noteSaved', text: note });
                      console.log(`[想法·${cstate.bookId}] ${note}`);
                    }
                  }
                }
                try {
                  session?.sendToolResponse({
                    functionResponses: m.toolCall.functionCalls.map((fc) => ({ id: fc.id, name: fc.name, response: { result: 'ok' } })),
                  });
                } catch {}
              }
            },
            onerror: (e) => send({ type: 'error', error: e?.message || String(e) }),
            onclose: (e) => send({ type: 'closed', reason: e?.reason || '' }),
          },
        });
      try {
        session = await openSession(msg.handle);
      } catch (e) {
        if (msg.handle) {
          try {
            session = await openSession(null); // 句柄可能过期，退回全新会话
            send({ type: 'staleHandle' });
          } catch (e2) {
            send({ type: 'error', error: e2?.message || String(e2) });
          }
        } else {
          send({ type: 'error', error: e?.message || String(e) });
        }
      }
    } else if (msg.type === 'audio' && session) {
      session.sendRealtimeInput({ audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' } });
    } else if (msg.type === 'video' && session) {
      session.sendRealtimeInput({ video: { data: msg.data, mimeType: 'image/jpeg' } });
    } else if (msg.type === 'text' && session) {
      session.sendClientContent({ turns: msg.text, turnComplete: true });
    } else if (msg.type === 'stop') {
      if (cstate.streamStart) {
        getUsage(user).streamingMs += Date.now() - cstate.streamStart;
        cstate.streamStart = 0;
        flushUser(user);
      }
      if (session) {
        try {
          session.close();
        } catch {}
        session = null;
      }
      summarizeProgress(user, cstate.bookId, cstate.transcript); // 这一程转写→更新进度
      cstate.transcript = []; // 清掉，避免 close 时重复总结
    }
  });

  browser.on('close', () => {
    if (cstate.streamStart) {
      getUsage(user).streamingMs += Date.now() - cstate.streamStart;
      cstate.streamStart = 0;
    }
    flushUser(user); // 断线时把这一程用量落库
    summarizeProgress(user, cstate.bookId, cstate.transcript); // 没走 stop 就断线，也把进度总结掉（stop 已清空则跳过）
    cstate.transcript = [];
    if (session) {
      try {
        session.close();
      } catch {}
      session = null;
    }
  });
});

const PORT = process.env.PORT || 5123;
const proto = haveCerts ? 'https' : 'http';
server.listen(PORT, '0.0.0.0', () => {
  console.log(`阅读陪伴（实时）${haveCerts ? '🔒 HTTPS' : 'HTTP'}`);
  console.log(`  Mac:  ${proto}://localhost:${PORT}`);
  console.log(`  手机: ${proto}://10.0.0.80:${PORT}  （同一 Wi-Fi，首次会提示证书不受信任，点继续）`);
  console.log('Gemini key:', KEY ? '已设置' : '未设置（在 .env 填 GEMINI_API_KEY）');
});
