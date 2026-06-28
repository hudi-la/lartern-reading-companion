// 实时后端：把浏览器的麦克风/摄像头流桥接到 Gemini Live（key 藏在这里，不进浏览器）。
// 浏览器 <-- WebSocket --> 本服务 <-- Gemini Live SDK --> Gemini
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

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

const VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';

// ===== 用量统计（服务端集中累计，给 /dashboard 看板用）=====
const RATES = { inText: 0.75, inAudio: 3, inVideo: 1, outText: 4.5, outAudio: 12 }; // $/百万 token
const USAGE_FILE = path.join(__dirname, 'data', 'usage.json');
const emptyUsage = () => ({ inAudio: 0, inVideo: 0, inText: 0, outAudio: 0, outText: 0 });
let usage = { ...emptyUsage(), streamingMs: 0, sessions: 0, startedAt: null };
try {
  if (fs.existsSync(USAGE_FILE)) usage = { ...usage, ...JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')) };
} catch {}
function saveUsage() {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch {}
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
// usageMetadata 是「会话累计」，按增量加进全局；cstate.last 记上次读数
function accrue(cstate, meta) {
  if (!usageLogged) {
    usageLogged = true;
    console.log('usageMetadata 样本:', JSON.stringify(meta));
  }
  const bd = extractBreakdown(meta);
  for (const k of Object.keys(emptyUsage())) usage[k] += Math.max(0, (bd[k] || 0) - (cstate.last[k] || 0));
  cstate.last = bd;
  if (!usage.startedAt) usage.startedAt = Date.now();
  saveUsage();
}
function usageCost(u) {
  return (u.inText * RATES.inText + u.inAudio * RATES.inAudio + u.inVideo * RATES.inVideo + u.outText * RATES.outText + u.outAudio * RATES.outAudio) / 1e6;
}

const app = express();
app.use(express.json({ limit: '12mb' })); // 封面图片走 JSON body
app.use(express.static(path.join(__dirname, 'web')));
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

// 用量看板数据
app.get('/usage', (req, res) => {
  const cost = usageCost(usage);
  const hours = usage.streamingMs / 3600000;
  res.json({ ...usage, cost, perHour: hours > 0 ? cost / hours : 0, rates: RATES, liveModel: MODEL });
});
app.post('/usage/reset', (req, res) => {
  usage = { ...emptyUsage(), streamingMs: 0, sessions: 0, startedAt: null };
  usageLogged = false;
  saveUsage();
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
const wss = new WebSocketServer({ server, path: '/live' });

wss.on('connection', (browser) => {
  let session = null;
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
      if (cstate.streamStart) usage.streamingMs += Date.now() - cstate.streamStart;
      cstate.last = emptyUsage();
      cstate.streamStart = Date.now();
      usage.sessions += 1;
      saveUsage();
      const ai = new GoogleGenAI({ apiKey: KEY });
      const openSession = (handle) =>
        ai.live.connect({
          model: MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
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
              if (m.usageMetadata) accrue(cstate, m.usageMetadata);
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
        usage.streamingMs += Date.now() - cstate.streamStart;
        cstate.streamStart = 0;
        saveUsage();
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
      usage.streamingMs += Date.now() - cstate.streamStart;
      cstate.streamStart = 0;
      saveUsage();
    }
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
