// 实时客户端：唤醒后开流 → 麦克风(16kHz PCM)+摄像头(0.5fps JPEG) → Gemini Live → 播放它的语音(24kHz)
// 状态机：stopped / live / listening(听) / thinking(思考) / speaking(讲解)，各有不同的呼吸球动画
const $ = (id) => document.getElementById(id);
// 暂停键在「暂停(⏸)/恢复(▶)」之间切换——用内联 Lucide SVG，和其余功能图标保持一致
const ICON_PAUSE =
  '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>';
const ICON_PLAY =
  '<svg class="ic" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>';
// 回答语言：核心是英美英语学习者（第二语言为英语、阅读吃力）人群的母语 Top5 —— 西/中/阿/波兰/乌尔都，外加常见几种
const REPLY_LANGS = [
  { v: 'zh', label: '中文', name: '中文' },
  { v: 'en', label: 'English', name: 'English' },
  { v: 'es', label: 'Español（西班牙语）', name: '西班牙语 (Español)' },
  { v: 'ar', label: 'العربية（阿拉伯语）', name: '阿拉伯语 (العربية)' },
  { v: 'pl', label: 'Polski（波兰语）', name: '波兰语 (Polski)' },
  { v: 'ur', label: 'اردو（乌尔都语）', name: '乌尔都语 (اردو)' },
  { v: 'vi', label: 'Tiếng Việt（越南语）', name: '越南语 (Tiếng Việt)' },
  { v: 'bn', label: 'বাংলা（孟加拉语）', name: '孟加拉语 (বাংলা)' },
  { v: 'fr', label: 'Français（法语）', name: '法语 (Français)' },
  { v: 'pt', label: 'Português（葡萄牙语）', name: '葡萄牙语 (Português)' },
];
const LANG_NAME = Object.fromEntries(REPLY_LANGS.map((l) => [l.v, l.name]));
const video = $('video');
const orb = $('orb');
const captureCanvas = $('captureCanvas');

let mode = 'companion';
let currentBook = null;
let camStream = null;
let micStream = null;

// 音频
let audioCtx = null; // 采集（输入）
let outCtx = null; // 播放（输出）
let processor = null;
let playHead = 0;
const scheduledSources = new Set();

// 实时会话
let ws = null;
let streaming = false;
let state = 'stopped';
let videoTimer = null;
let autoStopTimer = null;
let userActive = false;
let userSilenceTimer = null;
let turnAudioStarted = false;
let resumeHandle = null; // 会话续传句柄（重连/恢复后接着上下文）
let reconnecting = false;
let lastReconnect = 0;
let kickoffTimer = null;

// ---------- 工具 ----------
function log(t) {
  const d = document.createElement('div');
  d.textContent = `${new Date().toLocaleTimeString()}  ${t}`;
  $('log').prepend(d);
}
function setStatus(t) {
  $('statusText').textContent = t;
}
function caption(t) {
  const el = $('caption');
  el.textContent = t;
  if (t) {
    el.classList.remove('show');
    void el.offsetWidth; // 触发重排，重新播放淡入
    el.classList.add('show');
  }
}
function setState(s) {
  state = s;
  orb.className = 'orb ' + s;
  const labels = { stopped: '点一下唤醒', live: '已连接', listening: '在听…', thinking: '在想…', speaking: '在讲…（说话可打断）' };
  setStatus(labels[s] || '');
}

// ---------- 书（本地存储）----------
function loadBooks() {
  try {
    return JSON.parse(localStorage.getItem('books') || '[]');
  } catch {
    return [];
  }
}
function saveBooks(books) {
  localStorage.setItem('books', JSON.stringify(books));
  syncBooksUp(books); // 本地存一份做离线缓存，同时推云端
}
// ---------- 云端书库同步 ----------
let _syncTimer = null;
function syncBooksUp(books) {
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => {
    fetch('/books', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ books }) }).catch(() => {});
  }, 400); // 攒一下再传，避免连点连传
}
// 启动时拉云端，与本地按 id 取并集：云端是主，但本地离线加的书也补回去，谁都不丢
async function pullBooks() {
  let server;
  try {
    const r = await fetch('/books');
    if (!r.ok) return; // 未登录/离线 → 用本地
    server = (await r.json()).books;
  } catch {
    return;
  }
  if (!Array.isArray(server)) return;
  const byId = new Map();
  for (const b of server) if (b && b.id) byId.set(b.id, b);
  let localOnly = false;
  for (const b of loadBooks()) if (b && b.id && !byId.has(b.id)) { byId.set(b.id, b); localOnly = true; }
  const merged = [...byId.values()];
  localStorage.setItem('books', JSON.stringify(merged)); // 直接写，避免又触发上传
  if (server.length) localStorage.setItem('onboarded', '1'); // 云端已有书=老用户，换设备别再走引导
  if (localOnly) syncBooksUp(merged); // 本地有、云端没有的，补回云端
}
function setBookTitle() {
  $('bookTitle').textContent = currentBook ? currentBook.title : '未选择书';
}
// ---------- 程序化封面 ----------
// 标题+作者 → 稳定 hash → 查“配色 / 纹理 / 排版”表。同一本书永远同一张封面，
// 每套配色都是手挑过的，所以怎么选都好看；真图方案以后可作为可选增强图层叠加。
function hashStr(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}
// 渐变封面：每套都是三色渐变 + 字色 + 分隔线色 + 衬线/无衬线（字体也跟着变，更耐看）
const COVER_THEMES = [
  { g: ['#1a2a6c', '#6a1b3d', '#d4a017'], ink: '#fff',    rule: '#d4a017', font: 'cv-serif' },
  { g: ['#0f2027', '#203a43', '#2c5364'], ink: '#eaf2f4', rule: '#5fb0c4', font: 'cv-sans'  },
  { g: ['#f0f3f8', '#dbe2ef', '#c3cfe2'], ink: '#1a1f2e', rule: '#6b7a99', font: 'cv-serif' },
  { g: ['#41295a', '#642b73', '#c6426e'], ink: '#fff',    rule: '#f0a6c0', font: 'cv-serif' },
  { g: ['#16161a', '#3a2a1a', '#d98a2b'], ink: '#fdf3e3', rule: '#d98a2b', font: 'cv-serif' },
  { g: ['#0b3d2e', '#15634a', '#3f9e6f'], ink: '#eaf6ef', rule: '#7fd0a8', font: 'cv-sans'  },
  { g: ['#1f2430', '#33405a', '#5b7aa8'], ink: '#eef2f8', rule: '#8aa6d0', font: 'cv-serif' },
  { g: ['#2b1a3d', '#4a2c6d', '#7b5cc4'], ink: '#f0eaf7', rule: '#b99cf0', font: 'cv-sans'  },
  { g: ['#3a1212', '#6e2222', '#b85c3c'], ink: '#f7e9e0', rule: '#e0936b', font: 'cv-serif' },
  { g: ['#102a26', '#1d4d44', '#3a8f7a'], ink: '#e8f5f0', rule: '#74c7b0', font: 'cv-serif' },
  { g: ['#0d1b3a', '#1c3a6e', '#2f9fb5'], ink: '#e6f4f8', rule: '#5fc4d8', font: 'cv-sans'  },
  { g: ['#1a0e14', '#4a1f33', '#9c3b5a'], ink: '#f7e6ec', rule: '#d98aa6', font: 'cv-serif' },
];
// “企鹅式”色带封面：上下实色带 + 中间米白，最像正经出版书
const BAND_THEMES = [
  { band: '#e2552f', ink: '#fff' },
  { band: '#2f5d62', ink: '#fff' },
  { band: '#1c1c22', ink: '#fff' },
  { band: '#7a3b69', ink: '#fff' },
  { band: '#3a6ea5', ink: '#fff' },
];
// 纹理层：噪点 / 圆点 / 斜纹 / 网格 / 波纹，外加少量留白
const COVER_PATTERNS = ['cv-grain', 'cv-dots', 'cv-diag', 'cv-grid', 'cv-waves', 'cv-none'];
// 阅读对象类型：不只出版书，文章/书稿都给个角标，混合书架一眼分得清来源
const TYPE_META = {
  book:    { label: 'BOOK',    icon: '📖' },
  article: { label: 'ARTICLE', icon: '📄' },
  draft:   { label: 'DRAFT',   icon: '✍️' },
};
// 标题长度 → 字号档（CJK 字符算约 1.7 倍宽）
function titleLenClass(title) {
  const len = [...String(title)].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 1.7 : 1), 0);
  return len <= 7 ? 'cv-t1' : len <= 14 ? 'cv-t2' : len <= 24 ? 'cv-t3' : 'cv-t4';
}
function buildCover(card, b) {
  const seed = hashStr((b.title || '') + (b.author || ''));
  const type = TYPE_META[b.type] || TYPE_META.book;
  const title = b.title || '未命名';
  const badge = `<span class="cv-badge">${type.icon} ${type.label}</span>`;
  const titleEl = `<div class="cv-title ${titleLenClass(title)}">${esc(title)}</div>`;
  const authorEl = b.author ? `<div class="cv-author">${esc(b.author)}</div>` : '';
  // 约 1/5 的“书”走企鹅式色带，拉开和渐变款的差异
  if ((b.type || 'book') === 'book' && seed % 5 === 0) {
    const t = BAND_THEMES[seed % BAND_THEMES.length];
    card.className = 'book-card cv-band cv-serif';
    card.style.cssText = `--band:${t.band};--ink:${t.ink};`;
    card.innerHTML =
      `<div class="cv-band-top">${badge}</div>` +
      `<div class="cv-band-mid">${titleEl}</div>` +
      `<div class="cv-band-bot">${b.author ? esc(b.author) : '&nbsp;'}</div>`;
    return;
  }
  const t = COVER_THEMES[seed % COVER_THEMES.length];
  const angle = 130 + ((seed >> 3) % 6) * 10;
  const pat = COVER_PATTERNS[(seed >> 5) % COVER_PATTERNS.length];
  card.className = `book-card ${pat} ${t.font}`;
  card.style.cssText = `background:linear-gradient(${angle}deg,${t.g.join(',')});color:${t.ink};`;
  card.innerHTML =
    badge + '<div class="cv-spacer"></div>' + titleEl +
    `<div class="cv-rule" style="background:${t.rule}"></div>` + authorEl;
}
function renderLibrary() {
  const books = loadBooks();
  const grid = $('homeGrid');
  grid.innerHTML = '';
  books.forEach((b) => {
    const c = document.createElement('div');
    buildCover(c, b);
    c.onclick = () => enterBook(b);
    grid.appendChild(c);
  });
  const add = document.createElement('div');
  add.className = 'book-card add';
  add.innerHTML = '<div class="plus">＋</div><div>添加新书</div>';
  add.onclick = () => enterCapture();
  grid.appendChild(add);
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- 系统指令（书背景 + 模式）----------
function buildSystem() {
  const bg = currentBook && currentBook.background ? `这本书的背景资料：${currentBook.background} ` : '';
  const book = currentBook ? `读者正在读《${currentBook.title}》${currentBook.author ? '（' + currentBook.author + '）' : ''}。${bg}` : '';
  const langPref = localStorage.getItem('replyLang') || 'auto';
  let lang;
  if (langPref === 'auto') {
    lang = '默认用读者提问所用的语言回答：他用中文问就用中文答，用英文问就用英文答。';
  } else if (langPref === 'en') {
    lang = 'Always answer in English; quote the book’s original English text verbatim when needed.';
  } else if (langPref === 'zh') {
    lang = '请始终用中文回答（需要引用书里的英文原文时照引原文即可）。';
  } else {
    const n = LANG_NAME[langPref] || langPref;
    lang = `请始终用${n}回答，无论读者用什么语言提问；需要引用书里的英文原文时照引原文即可。`;
  }
  const common =
    `你是一个「阅读陪伴」助手，读者举着摄像头对着一本纸质书的一页，你能实时看到画面。${book}` +
    `默认以整页文字为准，画面里即使有手指也别假设他在问那里，除非他明确说"我指的这里/这个词"。` +
    `用自然口语回答、适合听，不要念清单式 1234，不要说"根据画面"。${lang}`;
  if (mode === 'explanation') {
    return (
      common +
      `现在是【讲解模式】，你是一位地道、口语化的英语精读老师，一对一带读者读这一页。` +
      `从这页最上面按顺序往下讲：简单句直接读过，复杂句读出原文、给自然中文意思、讲清地道表达/固定搭配/语法结构；` +
      `长难句帮他拆主干和修饰；顺手点 2-3 个难词在语境里的意思。讲透一两点即可，别面面俱到。讲完邀请他提问或翻下一页。`
    );
  }
  return common + `现在是【陪伴模式】：读者自己安静读，只有他开口问你才答；回答简短直接，只答所问，不主动延伸、不打断他。`;
}

// ---------- 摄像头 + 抓帧 ----------
// 默认后置（看书页）；camDeviceId 仅在用户从设置里手动指定某个摄像头时才用
let camFacing = 'environment'; // 'environment' 后置 / 'user' 前置
let camDeviceId = null;
async function startCamera() {
  try {
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    const get = (v) => navigator.mediaDevices.getUserMedia({ video: v, audio: false });
    const want = camDeviceId ? { deviceId: { exact: camDeviceId } } : { facingMode: { exact: camFacing } };
    try {
      camStream = await get(want); // 先按精确要求（手机上强制后置/前置）
    } catch {
      // 该朝向不存在（如桌面只有一个摄像头）→ 退回宽松匹配
      camStream = await get(camDeviceId ? { deviceId: camDeviceId } : { facingMode: { ideal: camFacing } });
    }
    video.srcObject = camStream;
    await video.play().catch(() => {});
    await listCameras();
    log('摄像头已开：' + (camStream.getVideoTracks()[0]?.label || '未知'));
  } catch (e) {
    log('摄像头错误：' + e.name + ' ' + e.message);
    setStatus('摄像头打开失败：' + e.name);
  }
}
// 翻转前/后摄像头
async function flipCamera() {
  camDeviceId = null; // 翻转回到朝向模式，清掉手动指定
  camFacing = camFacing === 'environment' ? 'user' : 'environment';
  await startCamera();
}
async function listCameras() {
  const sel = $('cameraSelect');
  if (!sel) return; // 摄像头选择 UI 已移除（改用翻转按钮）
  const prev = sel.value;
  const devs = await navigator.mediaDevices.enumerateDevices();
  const cams = devs.filter((d) => d.kind === 'videoinput');
  sel.innerHTML = '';
  cams.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = c.deviceId;
    o.textContent = c.label || `摄像头 ${i + 1}`;
    sel.appendChild(o);
  });
  if (prev && cams.some((c) => c.deviceId === prev)) sel.value = prev;
}
function captureFrameBase64(maxEdge = 768) {
  if (!video.videoWidth) return null;
  const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.round(video.videoWidth * scale);
  const h = Math.round(video.videoHeight * scale);
  captureCanvas.width = w;
  captureCanvas.height = h;
  captureCanvas.getContext('2d').drawImage(video, 0, 0, w, h);
  return captureCanvas.toDataURL('image/jpeg', 0.6).split(',')[1];
}

// ---------- 麦克风采集（16kHz PCM）----------
let micSource = null;
function setupAudioGraph() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  processor.connect(audioCtx.destination); // 必须连上才会触发；不往输出写，所以无回放
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    onMicLevel(rms);
    if (!streaming || !ws || ws.readyState !== 1) return;
    const pcm = floatToPCM16(downsampleTo16k(input, audioCtx.sampleRate));
    ws.send(JSON.stringify({ type: 'audio', data: abToBase64(pcm) }));
  };
}
async function attachMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false,
  });
  if (micSource) {
    try {
      micSource.disconnect();
    } catch {}
  }
  micSource = audioCtx.createMediaStreamSource(micStream);
  micSource.connect(processor);
}

// ---------- 暂停：硬关摄像头 + 麦克风 ----------
let paused = false;
function pauseMedia() {
  if (paused) return;
  // 关相机前先截下当前画面，作为暂停时的冻结背景（不全黑）
  const shot = captureFrameBase64(1080);
  if (shot) $('pausedShot').src = 'data:image/jpeg;base64,' + shot;
  if (streaming) stopStream();
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  micStream = null;
  paused = true;
  $('pauseBtn').innerHTML = ICON_PLAY;
  $('pauseBtn').title = '恢复摄像头和收音';
  $('pausedVeil').hidden = false;
  log('已暂停：摄像头与麦克风已关');
}
async function resumeMedia() {
  $('pausedVeil').hidden = true;
  $('pauseBtn').innerHTML = ICON_PAUSE;
  $('pauseBtn').title = '暂停摄像头和收音';
  paused = false;
  try {
    await startCamera();
    await attachMic();
    log('已恢复：摄像头与麦克风开启');
  } catch (e) {
    log('恢复失败：' + e.message);
  }
}
function togglePause() {
  paused ? resumeMedia() : pauseMedia();
}

// ---------- 添加新书：拍封面识别 ----------
function openCoverScan() {
  if (paused) resumeMedia();
  $('orbWrap').hidden = true;
  $('captureSkip').hidden = true;
  $('capText').textContent = '把书的封面对准画面，点下方拍摄';
  $('captureBar').hidden = false;
}
function exitCoverScan() {
  $('captureBar').hidden = true;
  $('orbWrap').hidden = false;
}
async function captureCover() {
  const img = captureFrameBase64(1024);
  if (!img) {
    $('capText').textContent = '摄像头还没准备好';
    return;
  }
  $('captureBtn').disabled = true;
  $('capText').textContent = '正在识别封面…';
  try {
    const res = await (
      await fetch('/identify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: img }) })
    ).json();
    $('captureBtn').disabled = false;
    if (!res.ok || !res.data || !res.data.title) {
      $('capText').textContent = '没认出书名，换个角度/光线再拍一次';
      $('captureSkip').hidden = false;
      return;
    }
    saveNewBook(res.data);
  } catch (e) {
    $('captureBtn').disabled = false;
    $('capText').textContent = '识别失败：' + e.message;
    $('captureSkip').hidden = false;
  }
}
function bgText(d) {
  return [
    d.summary ? '内容简介：' + d.summary : '',
    d.background ? '背景：' + d.background : '',
    d.keyConcepts && d.keyConcepts.length ? '关键概念：' + d.keyConcepts.join('、') : '',
  ]
    .filter(Boolean)
    .join('\n');
}
function normTitle(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}
function saveNewBook(d) {
  // 书柜里已有这本书：直接选中进入，不重复新建
  const existing = loadBooks().find((b) => normTitle(b.title) === normTitle(d.title) && normTitle(d.title));
  if (existing) {
    currentBook = existing;
    localStorage.setItem('currentBook', existing.id);
    resumeHandle = null;
    setBookTitle();
    goHome(`书房里已有《${existing.title}》 · 点开它继续读`);
    return;
  }
  const books = loadBooks();
  const book = { id: 'b' + Date.now(), title: d.title, author: d.author || '', background: bgText(d) };
  books.unshift(book);
  saveBooks(books);
  currentBook = book;
  localStorage.setItem('currentBook', book.id);
  resumeHandle = null;
  setBookTitle();
  goHome(`已加入书房：《${book.title}》 · 点开它开始读`);
}
function addBookBlank() {
  const books = loadBooks();
  const book = { id: 'b' + Date.now(), title: '未命名的书', author: '', background: '' };
  books.unshift(book);
  saveBooks(books);
  currentBook = book;
  localStorage.setItem('currentBook', book.id);
  resumeHandle = null;
  setBookTitle();
  goHome('已建一本空书 · 点开它，对准封面可重拍识别');
}
function downsampleTo16k(float32, inRate) {
  if (inRate === 16000) return float32;
  const ratio = inRate / 16000;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = float32[Math.floor(i * ratio)];
  return out;
}
function floatToPCM16(float32) {
  const buf = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
function abToBase64(ab) {
  const bytes = new Uint8Array(ab);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

const VAD_THRESH = 0.025;
function onMicLevel(rms) {
  if (state === 'listening') {
    const v = Math.min(1, Math.max(0, (rms - 0.01) * 8));
    orb.style.setProperty('--vol', v.toFixed(2));
  }
  if (!streaming) return;
  const speaking = rms > VAD_THRESH;
  if (speaking) {
    clearTimeout(userSilenceTimer);
    if (!userActive) {
      userActive = true;
      clearAutoStop(); // 你开口了，取消自动停流
      if (state !== 'speaking') setState('listening');
    }
  } else if (userActive) {
    clearTimeout(userSilenceTimer);
    userSilenceTimer = setTimeout(() => {
      userActive = false;
      if (streaming && state === 'listening') setState('thinking'); // 你停下了，等模型回应
    }, 600);
  }
}

// ---------- 播放 Gemini 的语音（24kHz PCM）----------
function ensureOutCtx() {
  if (!outCtx) outCtx = new (window.AudioContext || window.webkitAudioContext)();
  return outCtx;
}
function base64ToInt16(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}
function playPCM(b64) {
  const ctx = ensureOutCtx();
  const int16 = base64ToInt16(b64);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
  const buffer = ctx.createBuffer(1, float32.length, 24000);
  buffer.copyToChannel(float32, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  const start = Math.max(ctx.currentTime, playHead);
  src.start(start);
  playHead = start + buffer.duration;
  scheduledSources.add(src);
  src.onended = () => scheduledSources.delete(src);
}
function stopPlayback() {
  scheduledSources.forEach((s) => {
    try {
      s.stop();
    } catch {}
  });
  scheduledSources.clear();
  playHead = 0;
}

// ---------- 自动停流 ----------
function startAutoStop() {
  clearAutoStop();
  autoStopTimer = setTimeout(() => {
    if (streaming && !userActive) stopStream('讲完 5 秒无回应，自动停流');
  }, 5000);
}
function clearAutoStop() {
  clearTimeout(autoStopTimer);
  autoStopTimer = null;
}

// ---------- 开 / 停 实时流 ----------
async function wake() {
  if (streaming) return;
  if (!currentBook) {
    setStatus('请先回书房选一本书');
    return;
  }
  ensureOutCtx();
  if (outCtx.state === 'suspended') await outCtx.resume();
  if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();

  setState('live');
  caption('');
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/live');
  ws.onopen = () => {
    streaming = true;
    ws.send(JSON.stringify({ type: 'start', system: buildSystem(), handle: resumeHandle }));
    // 0.5 帧/秒发视频
    videoTimer = setInterval(() => {
      const f = captureFrameBase64();
      if (f && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'video', data: f }));
    }, 2000);
    // 讲解模式：只有「全新开始(没有续传句柄)」且你没先开口时才自动开讲，且不强制从头
    if (mode === 'explanation' && !resumeHandle) {
      clearTimeout(kickoffTimer);
      kickoffTimer = setTimeout(() => {
        if (streaming && ws && ws.readyState === 1 && !userActive) {
          ws.send(JSON.stringify({ type: 'text', text: '请带我精读我现在看到的这一页。' }));
        }
      }, 2500);
    }
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'open') {
      reconnecting = false;
      setState('listening');
    } else if (m.type === 'audio') {
      if (!turnAudioStarted) {
        turnAudioStarted = true;
        clearAutoStop();
        setState('speaking');
      }
      playPCM(m.data);
    } else if (m.type === 'interrupted') {
      stopPlayback();
      turnAudioStarted = false;
      setState('listening');
    } else if (m.type === 'turnComplete') {
      turnAudioStarted = false;
      setState('listening');
      startAutoStop();
    } else if (m.type === 'resumeHandle') {
      resumeHandle = m.handle; // 存住，重连/恢复时带回去
    } else if (m.type === 'goAway') {
      log('会话将到时(' + (m.timeLeft || '') + ')，续传重连…');
      reconnectGemini(); // 2 分钟上限前主动续传重连，体验上无缝
    } else if (m.type === 'staleHandle') {
      resumeHandle = null;
      log('续传句柄过期，已新开会话');
    } else if (m.type === 'error') {
      log('错误：' + m.error);
      setStatus('出错：' + m.error);
    } else if (m.type === 'closed') {
      log('会话关闭：' + (m.reason || ''));
      if (streaming && !reconnecting && resumeHandle && Date.now() - lastReconnect > 3000) reconnectGemini();
    }
  };
  ws.onclose = () => {
    if (streaming) stopStream();
  };
  ws.onerror = () => log('WebSocket 错误');
}

function reconnectGemini() {
  if (!streaming || !ws || ws.readyState !== 1 || reconnecting) return;
  reconnecting = true;
  lastReconnect = Date.now();
  stopPlayback();
  turnAudioStarted = false;
  ws.send(JSON.stringify({ type: 'start', system: buildSystem(), handle: resumeHandle }));
}

function stopStream(reason) {
  streaming = false;
  clearAutoStop();
  clearTimeout(kickoffTimer);
  clearInterval(videoTimer);
  videoTimer = null;
  stopPlayback();
  turnAudioStarted = false;
  userActive = false;
  if (ws) {
    try {
      ws.send(JSON.stringify({ type: 'stop' }));
      ws.close();
    } catch {}
    ws = null;
  }
  orb.style.setProperty('--vol', 0);
  setState('stopped');
  if (reason) {
    log(reason);
    setStatus(reason);
  }
}

// 点呼吸球：停流时=唤醒开流；运行中=手动停流（打断靠直接说话）
function onOrbTap() {
  if (streaming) stopStream('已手动停流');
  else wake();
}

// ---------- 双层导航：书房主页 ⇄ 阅读屏 ----------
// 彻底关掉相机与麦克风（回主页时用，给人「确实结束了」的踏实感）
function stopAllMedia() {
  if (streaming) stopStream();
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  micStream = null;
  mediaStarted = false;
  paused = false;
  $('pausedVeil').hidden = true;
  $('pauseBtn').innerHTML = ICON_PAUSE;
  try {
    video.srcObject = null;
  } catch {}
}
function goHome(hint) {
  stopAllMedia();
  $('captureBar').hidden = true;
  $('captureSkip').hidden = true;
  $('orbWrap').hidden = false;
  $('topBar').hidden = false;
  $('readingScreen').hidden = true;
  $('libraryHome').hidden = false;
  renderLibrary();
  $('homeHint').innerHTML = '<span class="dot-off"></span>' + (hint || '相机已关闭 · 选一本书开始');
}
async function enterBook(b) {
  currentBook = b;
  localStorage.setItem('currentBook', b.id);
  resumeHandle = null; // 换书=新对话
  setBookTitle();
  $('libraryHome').hidden = true;
  $('topBar').hidden = false;
  $('orbWrap').hidden = false;
  $('captureBar').hidden = true;
  $('readingScreen').hidden = false;
  try {
    await startMedia();
  } catch (e) {
    log('媒体启动失败：' + e.message);
    setStatus('需要摄像头/麦克风权限');
  }
  setState('stopped');
  inviteStart();
}
// 加书（扫封面）：临时进相机，只显示拍摄界面，拍完回主页
async function enterCapture() {
  $('libraryHome').hidden = true;
  $('readingScreen').hidden = false;
  $('topBar').hidden = true; // 拍封面时不显示阅读控件
  try {
    if (!camStream) await startCamera();
  } catch (e) {
    log('相机启动失败：' + e.message);
  }
  openCoverScan();
}

// ---------- 顶栏 / 设置 ----------
function setMode(m) {
  mode = m;
  const sel = $('modeSelect');
  if (sel) sel.value = m;
}

$('backBtn').onclick = () => goHome();
$('modeSelect').onchange = (e) => setMode(e.target.value);
function openSettings() {
  $('modeSelect').value = mode;
  $('settingsPanel').hidden = false;
}
$('homeSettings').onclick = openSettings;
$('readSettings').onclick = openSettings;
$('flipBtn').onclick = () => flipCamera();
$('helpBtn').onclick = () => ($('helpPanel').hidden = false);
orb.addEventListener('click', onOrbTap);
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => ($(b.dataset.close).hidden = true)));
document.querySelectorAll('.overlay').forEach((ov) =>
  ov.addEventListener('click', (e) => {
    if (e.target === ov) ov.hidden = true;
  })
);
$('pauseBtn').onclick = togglePause;
$('pausedVeil').onclick = resumeMedia; // 点暂停画面任意处即恢复
$('captureBtn').onclick = captureCover;
$('captureSkip').onclick = addBookBlank;
$('captureCancel').onclick = () => goHome();
function buildLangSelects() {
  $('replyLang').innerHTML =
    '<option value="auto">自动（跟随我提问的语言）</option>' + REPLY_LANGS.map((l) => `<option value="${l.v}">${l.label}</option>`).join('');
  $('obLangSelect').innerHTML = REPLY_LANGS.map((l) => `<option value="${l.v}">${l.label}</option>`).join('');
  const cur = localStorage.getItem('replyLang') || 'auto';
  $('replyLang').value = cur;
  if (cur !== 'auto') {
    $('obLangSelect').value = cur;
    obSetLangMode('pick');
  }
}
buildLangSelects();
$('modeSelect').value = mode;
$('replyLang').onchange = (e) => localStorage.setItem('replyLang', e.target.value);

// ---------- 媒体启动（摄像头 + 麦克风）----------
let mediaStarted = false;
async function startMedia() {
  await startCamera();
  setupAudioGraph();
  await attachMic(); // 权限被拒会在这里抛错
  mediaStarted = true;
}

// ---------- 首次进门引导 ----------
const OB_STEPS = 5;
let obStep = 0;
function obRenderDots() {
  const wrap = $('obDots');
  wrap.innerHTML = '';
  for (let i = 0; i < OB_STEPS; i++) {
    const d = document.createElement('i');
    if (i === obStep) d.className = 'on';
    wrap.appendChild(d);
  }
}
function obShow(i) {
  obStep = i;
  document.querySelectorAll('.ob-step').forEach((s) => (s.hidden = +s.dataset.step !== i));
  obRenderDots();
}
function obNext() {
  if (obStep < OB_STEPS - 1) obShow(obStep + 1);
}
function startOnboarding() {
  $('onboarding').hidden = false;
  obShow(0);
}
function obCreateBook(title, author) {
  const books = loadBooks();
  const book = { id: 'b' + Date.now(), title: title.trim() || '未命名的书', author: (author || '').trim(), background: '' };
  books.unshift(book);
  saveBooks(books);
  currentBook = book;
  localStorage.setItem('currentBook', book.id);
  resumeHandle = null;
  setBookTitle();
  renderLibrary();
}
// 加书成功后，邀请用户点呼吸球开始
function inviteStart() {
  setStatus('点一下，开始陪你读');
  if (currentBook) caption(`准备好了，点中间的球，开始陪你读《${currentBook.title}》。`);
}
async function finishOnboarding(after) {
  localStorage.setItem('onboarded', '1');
  $('onboarding').hidden = true;
  if (after === 'scan') {
    enterCapture(); // 直接进相机扫封面，拍完回书房主页
    return;
  }
  goHome(); // 落到书房主页，相机关闭
}

// 引导各步交互
document.querySelectorAll('#onboarding [data-next]').forEach((b) => (b.onclick = obNext));
$('obPermBtn').onclick = async () => {
  const btn = $('obPermBtn');
  $('obPermHint').textContent = '';
  btn.disabled = true;
  btn.textContent = '请求中…';
  try {
    await startMedia();
    if (!camStream || !micStream) throw new Error('denied');
    obNext();
  } catch {
    $('obPermHint').textContent = '没拿到权限，请在浏览器里点「允许」后再试';
  } finally {
    btn.disabled = false;
    btn.textContent = '允许访问';
  }
};
// 语言选择：'auto'（跟随提问）或 'pick'（用下拉指定的语言）
function obSetLangMode(mode) {
  $('obLang').querySelector('[data-lang="auto"]').classList.toggle('on', mode === 'auto');
  $('obLangPick').classList.toggle('on', mode === 'pick');
  const v = mode === 'auto' ? 'auto' : $('obLangSelect').value;
  localStorage.setItem('replyLang', v);
  $('replyLang').value = v;
}
$('obLang').querySelector('[data-lang="auto"]').onclick = () => obSetLangMode('auto');
$('obLangPick').onclick = () => obSetLangMode('pick');
$('obLangSelect').onchange = () => obSetLangMode('pick');
$('obBookScan').onclick = () => finishOnboarding('scan'); // 默认：去主界面扫封面识别
$('obManualToggle').onclick = () => {
  $('obManual').hidden = false;
  $('obBookScan').hidden = true;
  $('obManualToggle').hidden = true;
  $('obBookTitle').focus();
};
$('obBookSave').onclick = () => {
  obCreateBook($('obBookTitle').value, $('obBookAuthor').value);
  finishOnboarding();
};

// ---------- 启动 ----------
(async function init() {
  try {
    const st = await (await fetch('/status')).json();
    if (st.ready) {
      $('liveDot').classList.add('ok');
      $('liveDot').title = '模型就绪：' + st.model;
    } else {
      $('liveDot').title = '未设置 GEMINI_API_KEY';
    }
  } catch {}

  await pullBooks(); // 先把云端书库拉下来合并，再决定落点

  const books = loadBooks();
  const cur = localStorage.getItem('currentBook');
  currentBook = books.find((b) => b.id === cur) || null;
  setBookTitle();
  setState('stopped');

  if (!localStorage.getItem('onboarded')) {
    startOnboarding(); // 第一次进门：走引导，权限和第一本书都在里面拿
    return;
  }

  goHome(); // 老用户：落到书房主页，相机关闭
})();
