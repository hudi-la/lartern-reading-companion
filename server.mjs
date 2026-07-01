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
import { GoogleGenAI, Modality } from '@google/genai';
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
// 仅「本机直连」（回环地址且未经反向代理）时，允许 ?as= 写入的 rc_as 覆盖用户名，用来在本地测新用户初次流程。
// 线上跑在 Render 反代后面（会带 x-forwarded-*），一律不认，杜绝被绕过登录。
function localDirect(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  const loopback = ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';
  return loopback && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-proto'];
}
function devAs(req) {
  return localDirect(req) ? decodeURIComponent(parseCookies(req).rc_as || '') : '';
}
function isAuthed(req) {
  if (!AUTH_ON) return true; // 没配用户 = 放行（本地开发）
  if (devAs(req)) return true; // 本机 ?as= 测试会话放行
  return TOKEN_TO_USER.has(parseCookies(req).rc_auth || '');
}
function getUser(req) {
  const as = devAs(req);
  if (as) return as; // 本机 ?as= 覆盖：测新用户用
  if (!AUTH_ON) return '本机';
  return TOKEN_TO_USER.get(parseCookies(req).rc_auth || '') || '匿名';
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

// 门禁：未登录的，网页跳登录页，接口返回 401
app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if ((req.headers.accept || '').includes('text/html')) return res.redirect('/login');
  res.status(401).json({ error: 'unauthorized' });
});

// no-cache：开发/迭代期保证手机和浏览器永远拿最新前端，避免「改了看不到」
app.use(express.static(path.join(__dirname, 'web'), { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));
app.get('/status', (req, res) => res.json({ ready: Boolean(KEY), model: MODEL }));

// 一次性识别封面：图片 -> 书名/作者/背景 JSON
app.post('/identify', async (req, res) => {
  if (!KEY) return res.json({ ok: false, error: '未设置 GEMINI_API_KEY' });
  const image = req.body?.image;
  if (!image) return res.json({ ok: false, error: '没有图像' });
  try {
    const ai = new GoogleGenAI({ apiKey: KEY });
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

// 用量看板数据
app.get('/usage', (req, res) => {
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
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'web', 'dashboard.html')));

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
  const cstate = { last: emptyUsage(), streamStart: 0 };
  const send = (obj) => browser.readyState === 1 && browser.send(JSON.stringify(obj));

  browser.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'start') {
      if (!KEY) return send({ type: 'error', error: '未设置 GEMINI_API_KEY' });
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
      const ai = new GoogleGenAI({ apiKey: KEY });
      const openSession = (handle) =>
        ai.live.connect({
          model: MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } }, // 钉死默认嗓「Zephyr」（女声/明亮），防模型更新后被换掉
            systemInstruction: msg.system || '',
            sessionResumption: handle ? { handle } : {}, // 开启会话续传
            contextWindowCompression: { slidingWindow: {} }, // 压缩上下文以延长会话
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
              if (sc?.interrupted) send({ type: 'interrupted' });
              if (sc?.turnComplete) send({ type: 'turnComplete' });
              if (m.sessionResumptionUpdate?.newHandle) send({ type: 'resumeHandle', handle: m.sessionResumptionUpdate.newHandle });
              if (m.goAway) send({ type: 'goAway', timeLeft: m.goAway?.timeLeft });
              if (m.usageMetadata) accrue(user, cstate, m.usageMetadata);
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
    }
  });

  browser.on('close', () => {
    if (cstate.streamStart) {
      getUsage(user).streamingMs += Date.now() - cstate.streamStart;
      cstate.streamStart = 0;
    }
    flushUser(user); // 断线时把这一程用量落库
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
