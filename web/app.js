// 实时客户端：唤醒后开流 → 麦克风(16kHz PCM)+摄像头(0.5fps JPEG) → Gemini Live → 播放它的语音(24kHz)
// 状态机：stopped / live / listening(听) / thinking(思考) / speaking(讲解)，各有不同的呼吸球动画
const $ = (id) => document.getElementById(id);
// 暂停键在「暂停(⏸)/恢复(▶)」之间切换——用内联 Lucide SVG，和其余功能图标保持一致
const ICON_PAUSE =
  '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>';
const ICON_PLAY =
  '<svg class="ic" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>';
// 回答语言：按美/英国际学生来源国的母语排（印/中/韩为主；乌尔都=巴基斯坦，英国第4来源），外加常见几种。名单只是显式入口，选 Auto 也能跟随任意提问语言
const REPLY_LANGS = [
  { v: 'zh', label: '中文 (Chinese)', name: '中文' },
  { v: 'en', label: 'English', name: 'English' },
  { v: 'hi', label: 'हिन्दी (Hindi)', name: '印地语 (हिन्दी)' },
  { v: 'ko', label: '한국어 (Korean)', name: '韩语 (한국어)' },
  { v: 'es', label: 'Español (Spanish)', name: '西班牙语 (Español)' },
  { v: 'ar', label: 'العربية (Arabic)', name: '阿拉伯语 (العربية)' },
  { v: 'pl', label: 'Polski (Polish)', name: '波兰语 (Polski)' },
  { v: 'ur', label: 'اردو (Urdu)', name: '乌尔都语 (اردو)' },
  { v: 'vi', label: 'Tiếng Việt (Vietnamese)', name: '越南语 (Tiếng Việt)' },
  { v: 'bn', label: 'বাংলা (Bengali)', name: '孟加拉语 (বাংলা)' },
  { v: 'fr', label: 'Français (French)', name: '法语 (Français)' },
  { v: 'pt', label: 'Português (Portuguese)', name: '葡萄牙语 (Português)' },
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
  const labels = { stopped: 'Tap to wake', live: 'Connected', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking… (interrupt anytime)' };
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
  let server, user;
  try {
    const r = await fetch('/books');
    if (!r.ok) return; // 未登录/离线 → 用本地
    const j = await r.json();
    server = j.books;
    user = j.user;
  } catch {
    return;
  }
  if (!Array.isArray(server)) return;
  // 账号切换（本地 ?as=xxx 测试用）→ 清掉上个账号的本地缓存，从干净状态走该账号的引导流程
  if (user && localStorage.getItem('lastUser') !== user) {
    localStorage.removeItem('books');
    localStorage.removeItem('onboarded');
    localStorage.removeItem('readerProfile');
    readerProfile = null;
    localStorage.setItem('lastUser', user);
  }
  const byId = new Map();
  for (const b of server) if (b && b.id) byId.set(b.id, b);
  let localOnly = false;
  for (const b of loadBooks()) if (b && b.id && !byId.has(b.id)) { byId.set(b.id, b); localOnly = true; }
  const merged = [...byId.values()];
  localStorage.setItem('books', JSON.stringify(merged)); // 直接写，避免又触发上传
  if (server.length) localStorage.setItem('onboarded', '1'); // 云端已有书=老用户，换设备别再走引导
  if (localOnly) syncBooksUp(merged); // 本地有、云端没有的，补回云端
}
// 进书时拉这本书的感想 + 滚动进度（进度会注入 systemInstruction）
async function pullMemory(bookId) {
  currentMemory = { reflections: [], progress: '' };
  if (!bookId) return;
  try {
    const r = await fetch('/memory?book=' + encodeURIComponent(bookId));
    if (!r.ok) return;
    const j = await r.json();
    currentMemory = { reflections: j.reflections || [], progress: j.progress || '' };
  } catch {}
}
// 拉取读者画像（seed）；云端有就以云端为准，落一份到本地缓存
async function pullProfile() {
  try {
    const r = await fetch('/profile');
    if (!r.ok) return;
    const j = await r.json();
    const seed = j && j.seed;
    if (seed && (seed.level || (Array.isArray(seed.painpoints) && seed.painpoints.length))) {
      readerProfile = seed;
      localStorage.setItem('readerProfile', JSON.stringify(seed));
    }
  } catch {}
}
function setBookTitle() {
  $('bookTitle').textContent = currentBook ? currentBook.title : 'No book selected';
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
  const title = b.title || 'Untitled';
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
    const nb = document.createElement('button');
    nb.className = 'card-notes';
    nb.title = 'Notes';
    nb.innerHTML =
      '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    nb.onclick = (e) => {
      e.stopPropagation(); // 只看想法，不进入阅读
      openBookNotesById(b);
    };
    c.appendChild(nb);
    grid.appendChild(c);
  });
  const add = document.createElement('div');
  add.className = 'book-card add';
  add.innerHTML = '<div class="plus">＋</div><div>Add book</div>';
  add.onclick = () => enterCapture();
  grid.appendChild(add);
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- 读者画像（onboarding 选的 seed；纯描述，两个模式都注入）----------
function loadProfileLocal() {
  try {
    return JSON.parse(localStorage.getItem('readerProfile') || 'null');
  } catch {
    return null;
  }
}
let readerProfile = loadProfileLocal();
let currentMemory = { reflections: [], progress: '' }; // 当前书的滚动进度（进书时从 /memory 拉，注入 systemInstruction）
// 「记一笔」行为 prompt 两版，?rv=1 / ?rv=2 切换对比
const REFLECT_V1 =
  '读者常会一边读一边冒出对内容的想法/读后感。别只当成语言提问——把你俩讨论后成型的那个想法用「记一笔」存下来，并顺口说一句“那我们把这个记下来”。单纯的单词/语法问题不算想法，别记。';
const REFLECT_V2 =
  '读者常会一边读一边冒出对内容的想法/读后感。别只当成提问——跟他聊聊、也讲讲你自己的看法；聊到一个点上，把你俩讨论后成型的那个想法用「记一笔」存下来，并顺口说一句“那我们把这个记下来”。单纯的单词/语法问题不算想法，别记。';
function reflectPrompt() {
  return localStorage.getItem('reflectV') === '1' ? REFLECT_V1 : REFLECT_V2; // 默认 V2（有讨论）
}
// 纯描述读者，不规定 AI 动作；两个模式共用，由模式各自的行为规则去消化
const LEVEL_DESC = {
  A: '词汇量较浅，四级左右的词就开始吃力，生僻词基本不认识。',
  B: '掌握日常高频词，生词多是进阶书面词（读原版常遇、超出课本核心的那类）。',
  C: '词汇量不错，只有较低频或学术词才会卡。',
  D: '接近母语水平，词义几乎不构成障碍。',
};
const PAIN_DESC = { 生词: '生词', 长句: '长难句', 文化: '文化梗和典故', 文体: '方言、古旧或特殊文体', 专业: '专业词汇' };
function profileClause() {
  const p = readerProfile;
  if (!p) return '';
  let s = '';
  if (p.level && LEVEL_DESC[p.level]) s += LEVEL_DESC[p.level];
  const pains = (p.painpoints || []).map((k) => PAIN_DESC[k]).filter(Boolean);
  if (pains.length) s += '读英文书时容易卡在：' + pains.join('、') + '。';
  return s ? `这位读者的情况：${s}` : '';
}

// ---------- 系统指令（书背景 + 模式）----------
function buildSystem() {
  const bg = currentBook && currentBook.background ? `这本书的背景资料：${currentBook.background} ` : '';
  const prog = currentMemory.progress ? `目前读到这里：${currentMemory.progress} ` : '';
  const book = currentBook ? `读者正在读《${currentBook.title}》${currentBook.author ? '（' + currentBook.author + '）' : ''}。${bg}${prog}` : '';
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
    `你主要作为语言老师给出指导。读者用手指指着某个词或某一行问时，就以他指尖所指的地方为准；没有明确所指时，以整页文字为准，也留意画面里的插图。` +
    `用自然口语回答、适合听，不要念清单式 1234，不要说"根据画面"。${lang}`;
  if (mode === 'explanation') {
    return (
      common +
      `现在是【精读模式】，你是一位地道、口语化的英语精读老师，和读者一起对着这一页，一对一带读者读这一页。` +
      `开场先读出这一页的第一句——说"这一页从……开始"，然后把球抛给他：请他读下一句、或说说这句大概什么意思。` +
      `之后一句一句往下：他读或答完，顺就肯定一下、带到下一句；卡在某个词读不出来就帮他读、点一下意思；读错或理解偏了就轻轻纠正；难句他答不上来，再简短帮他拆一下，别长篇。` +
      `每次只推进一两句，给他开口的空档；他问你就答。自然口语、简短，像坐在他旁边陪他读。` +
      reflectPrompt() +
      profileClause()
    );
  }
  return (
    common +
    `现在是【陪伴模式】：读者自己安静读，只有他开口问你才答；回答简短直接，只答所问，不主动延伸、不打断他、不邀请提问。` +
    profileClause()
  );
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
    log('Camera on: ' + (camStream.getVideoTracks()[0]?.label || 'unknown'));
    startPageBuffer();
  } catch (e) {
    log('Camera error: ' + e.name + ' ' + e.message);
    setStatus('Camera failed to open: ' + e.name);
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
    o.textContent = c.label || `Camera ${i + 1}`;
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

// ---------- 默读页缓冲 ----------
// 陪伴模式不开流时，读者翻过的页 AI 看不到。这里在后台每隔几秒抓一帧、翻页才记，
// 唤醒时把这几张默读过的页作为静默上下文补给模型，补上「它不知道我刚读了啥」的坑。
let pageBuffer = [];
let lastThumb = null;
let bufferTimer = null;
const BUFFER_MAX = 4; // 最多留最近 4 张不同的页
const bufCanvas = document.createElement('canvas');
function thumbData() {
  if (!video.videoWidth) return null;
  const tw = 48;
  const th = Math.max(1, Math.round((48 * video.videoHeight) / video.videoWidth));
  bufCanvas.width = tw;
  bufCanvas.height = th;
  const ctx = bufCanvas.getContext('2d');
  ctx.drawImage(video, 0, 0, tw, th);
  return ctx.getImageData(0, 0, tw, th).data;
}
function thumbDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]); // 看 R 通道就够判翻页
    n++;
  }
  return n ? sum / n : Infinity;
}
function bufferTick() {
  if (paused) return;
  const t = thumbData();
  if (!t) return;
  if (thumbDiff(t, lastThumb) <= 12) return; // 画面没明显变（同一页）→ 不记
  lastThumb = t;
  if (streaming) return; // 开流时模型已实时看到，无需缓冲
  const f = captureFrameBase64();
  if (!f) return;
  pageBuffer.push(f);
  if (pageBuffer.length > BUFFER_MAX) pageBuffer.shift();
}
function startPageBuffer() {
  clearInterval(bufferTimer);
  lastThumb = null; // 相机（重）开，重新校准
  bufferTimer = setInterval(bufferTick, 4000);
}
function stopPageBuffer() {
  clearInterval(bufferTimer);
  bufferTimer = null;
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
  $('pauseBtn').title = 'Resume camera & mic';
  $('pausedVeil').hidden = false;
  log('Paused: camera and mic off');
}
async function resumeMedia() {
  $('pausedVeil').hidden = true;
  $('pauseBtn').innerHTML = ICON_PAUSE;
  $('pauseBtn').title = 'Pause camera & mic';
  paused = false;
  try {
    await startCamera();
    await attachMic();
    log('Resumed: camera and mic on');
  } catch (e) {
    log('Resume failed: ' + e.message);
  }
}
function togglePause() {
  paused ? resumeMedia() : pauseMedia();
}

// ---------- 添加新书：拍封面识别 ----------
function openCoverScan() {
  if (paused) resumeMedia();
  $('orbWrap').hidden = true;
  resetCaptureManual();
  $('capText').textContent = 'Aim the book cover at the frame, then tap below';
  $('captureBar').hidden = false;
}
function exitCoverScan() {
  $('captureBar').hidden = true;
  $('orbWrap').hidden = false;
}
// 手动填写面板：收起、清空，回到「拍摄封面 + 手动填写」两个入口
function resetCaptureManual() {
  $('capManual').hidden = true;
  $('captureBtn').hidden = false;
  $('capManualToggle').hidden = false;
  $('capBookTitle').value = '';
  $('capBookAuthor').value = '';
}
// 展开手动填写：藏掉拍摄入口，露出书名/作者输入
function openCaptureManual() {
  $('capManual').hidden = false;
  $('captureBtn').hidden = true;
  $('capManualToggle').hidden = true;
  $('capText').textContent = 'Enter the title manually (author optional)';
  $('capBookTitle').focus();
}
// 手动保存：留空则等于建一本空书
function addBookManual() {
  saveNewBook({ title: $('capBookTitle').value.trim() || 'Untitled book', author: $('capBookAuthor').value.trim() });
}
async function captureCover() {
  const img = captureFrameBase64(1024);
  if (!img) {
    $('capText').textContent = 'Camera not ready yet';
    return;
  }
  $('captureBtn').disabled = true;
  $('capText').textContent = 'Scanning cover…';
  try {
    const res = await (
      await fetch('/identify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: img }) })
    ).json();
    $('captureBtn').disabled = false;
    if (!res.ok || !res.data || !res.data.title) {
      $('capText').textContent = 'Couldn\'t read the title — try another angle, or enter it manually below';
      return;
    }
    saveNewBook(res.data);
  } catch (e) {
    $('capText').textContent = 'Scan failed: ' + e.message + ' — retake or enter manually';
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
    goHome(`Already in your library: “${existing.title}” · tap to continue`);
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
  goHome(`Added to your library: “${book.title}” · tap to start`);
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
    if (streaming && !userActive) stopStream('Auto-stopped: 5s of silence after speaking');
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
    setStatus('Go back and pick a book first');
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
    ws.send(JSON.stringify({ type: 'start', system: buildSystem(), handle: resumeHandle, bookId: currentBook?.id || '' }));
    // 把默读时翻过的几页作为静默上下文补给模型（陪伴模式失忆的坑），发完清空、避免下次重发
    for (const f of pageBuffer) ws.send(JSON.stringify({ type: 'video', data: f }));
    pageBuffer = [];
    // 0.5 帧/秒发视频
    videoTimer = setInterval(() => {
      const f = captureFrameBase64();
      if (f && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'video', data: f }));
    }, 2000);
    // 精读模式：只有「全新开始(没有续传句柄)」且你没先开口时才自动开场，且不强制从头
    if (mode === 'explanation' && !resumeHandle) {
      clearTimeout(kickoffTimer);
      kickoffTimer = setTimeout(() => {
        if (streaming && ws && ws.readyState === 1 && !userActive) {
          ws.send(JSON.stringify({ type: 'text', text: '从这一页第一句开始，带我精读。' }));
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
    } else if (m.type === 'transcript') {
      log((m.role === 'in' ? '你：' : 'AI：') + m.text); // 转写回显，看中英混说准不准
    } else if (m.type === 'noteSaved') {
      currentMemory.reflections.push({ text: m.text, at: Date.now() }); // 当场进当前书的想法列表
      caption('✓ 记下了：' + m.text);
      setStatus('已记下一条想法');
    } else if (m.type === 'goAway') {
      log('Session nearing limit (' + (m.timeLeft || '') + '), resuming…');
      reconnectGemini(); // 2 分钟上限前主动续传重连，体验上无缝
    } else if (m.type === 'staleHandle') {
      resumeHandle = null;
      log('Resume handle expired; started a new session');
    } else if (m.type === 'error') {
      log('Error: ' + m.error);
      setStatus('Error: ' + m.error);
    } else if (m.type === 'closed') {
      log('Session closed: ' + (m.reason || ''));
      if (streaming && !reconnecting && resumeHandle && Date.now() - lastReconnect > 3000) reconnectGemini();
    }
  };
  ws.onclose = () => {
    if (streaming) stopStream();
  };
  ws.onerror = () => log('WebSocket error');
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
  if (streaming) stopStream('Stopped manually');
  else wake();
}

// ---------- 双层导航：书房主页 ⇄ 阅读屏 ----------
// 彻底关掉相机与麦克风（回主页时用，给人「确实结束了」的踏实感）
function stopAllMedia() {
  if (streaming) stopStream();
  stopPageBuffer();
  pageBuffer = [];
  lastThumb = null;
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
  resetCaptureManual();
  $('orbWrap').hidden = false;
  $('topBar').hidden = false;
  $('readingScreen').hidden = true;
  $('libraryHome').hidden = false;
  renderLibrary();
  $('homeHint').innerHTML = '<span class="dot-off"></span>' + (hint || 'Camera off · Pick a book to start');
}
async function enterBook(b) {
  currentBook = b;
  localStorage.setItem('currentBook', b.id);
  resumeHandle = null; // 换书=新对话
  pageBuffer = []; // 换书清空默读缓冲，别把上一本的页带过来
  await pullMemory(b.id); // 拉这本书的进度（注入）+ 感想
  setBookTitle();
  $('libraryHome').hidden = true;
  $('topBar').hidden = false;
  $('orbWrap').hidden = false;
  $('captureBar').hidden = true;
  $('readingScreen').hidden = false;
  try {
    await startMedia();
  } catch (e) {
    log('Media failed to start: ' + e.message);
    setStatus('Camera/mic permission needed');
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
    log('Camera failed to start: ' + e.message);
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
function renderNotes() {
  const wrap = $('notesList');
  if (!wrap) return;
  const notes = (currentMemory.reflections || []).slice().reverse();
  wrap.innerHTML = notes.length
    ? notes.map((n) => `<div class="note-item">${esc(n.text)}</div>`).join('')
    : '<div class="notes-empty">还没有记下想法。<br>读书时随口聊聊你的感想，它会顺手帮你记。</div>';
}
$('notesBtn').onclick = () => {
  $('notesTitle').textContent = '这本书的想法';
  renderNotes();
  $('notesPanel').hidden = false;
};
// 书房入口：一次看全部书的想法，按书分组，方便读完回来采收
async function openAllNotes() {
  const wrap = $('notesList');
  $('notesTitle').textContent = '读书想法';
  wrap.innerHTML = '<div class="notes-empty">加载中…</div>';
  $('notesPanel').hidden = false;
  let all = {};
  try {
    const r = await fetch('/memory');
    if (r.ok) all = (await r.json()).books || {};
  } catch {}
  const books = loadBooks();
  const titleOf = (id) => books.find((b) => b.id === id)?.title || '未知的书';
  const sections = Object.entries(all)
    .filter(([, m]) => (m.reflections || []).length)
    .map(([id, m]) => {
      const items = m.reflections
        .slice()
        .reverse()
        .map((n) => `<div class="note-item">${esc(n.text)}</div>`)
        .join('');
      return `<div class="notes-book"><div class="notes-book-title">${esc(titleOf(id))}</div>${items}</div>`;
    });
  wrap.innerHTML = sections.length
    ? sections.join('')
    : '<div class="notes-empty">还没有记下想法。<br>读书时随口聊聊你的感想，它会顺手帮你记。</div>';
}
$('homeNotesBtn').onclick = openAllNotes;
// 单本书的想法（从书卡点进来）
async function openBookNotesById(book) {
  $('notesTitle').textContent = `《${book.title}》的想法`;
  const wrap = $('notesList');
  wrap.innerHTML = '<div class="notes-empty">加载中…</div>';
  $('notesPanel').hidden = false;
  let mem = { reflections: [] };
  try {
    const r = await fetch('/memory?book=' + encodeURIComponent(book.id));
    if (r.ok) mem = await r.json();
  } catch {}
  const notes = (mem.reflections || []).slice().reverse();
  wrap.innerHTML = notes.length
    ? notes.map((n) => `<div class="note-item">${esc(n.text)}</div>`).join('')
    : '<div class="notes-empty">这本书还没有记下想法。</div>';
}
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
$('capManualToggle').onclick = openCaptureManual;
$('capBookSave').onclick = addBookManual;
$('captureCancel').onclick = () => goHome();
function buildLangSelects() {
  $('replyLang').innerHTML =
    '<option value="auto">Auto (match the language I ask in)</option>' + REPLY_LANGS.map((l) => `<option value="${l.v}">${l.label}</option>`).join('');
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
const OB_STEPS = 6;
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
  const book = { id: 'b' + Date.now(), title: title.trim() || 'Untitled book', author: (author || '').trim(), background: '' };
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
  setStatus('Tap to start reading together');
  if (currentBook) caption(`Ready — tap the center orb to start reading “${currentBook.title}”.`);
}
async function finishOnboarding(after) {
  localStorage.setItem('onboarded', '1');
  saveReaderProfile(); // 存下画像页两题的选择
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
  btn.textContent = 'Requesting…';
  try {
    await startMedia();
    if (!camStream || !micStream) throw new Error('denied');
    obNext();
  } catch {
    $('obPermHint').textContent = 'Permission denied — tap “Allow” in your browser and try again';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Allow access';
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
// 画像页：卡点多选（切换 on），词表档单选（互斥）
document.querySelectorAll('#obPain button').forEach((b) => (b.onclick = () => b.classList.toggle('on')));
document.querySelectorAll('#obLevel button').forEach(
  (b) =>
    (b.onclick = () => {
      document.querySelectorAll('#obLevel button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    }),
);
// 收集画像选择 → 本地缓存 + 推云端（seed）
function saveReaderProfile() {
  const painpoints = [...document.querySelectorAll('#obPain button.on')].map((b) => b.dataset.pain);
  const levelBtn = document.querySelector('#obLevel button.on');
  const level = levelBtn ? levelBtn.dataset.level : '';
  readerProfile = { level, painpoints };
  localStorage.setItem('readerProfile', JSON.stringify(readerProfile));
  fetch('/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: readerProfile }) }).catch(() => {});
}
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
  const rv = new URLSearchParams(location.search).get('rv');
  if (rv === '1' || rv === '2') localStorage.setItem('reflectV', rv); // 切「记一笔」prompt 版本对比
  try {
    const st = await (await fetch('/status')).json();
    if (st.ready) {
      $('liveDot').classList.add('ok');
      $('liveDot').title = 'Model ready: ' + st.model;
    } else {
      $('liveDot').title = 'GEMINI_API_KEY not set';
    }
  } catch {}

  await pullBooks(); // 先把云端书库拉下来合并，再决定落点
  await pullProfile(); // 拉读者画像（注入精读模式）

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
