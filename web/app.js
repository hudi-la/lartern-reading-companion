// 实时客户端：唤醒后开流 → 麦克风(16kHz PCM)+摄像头(0.5fps JPEG) → Gemini Live → 播放它的语音(24kHz)
// 状态机：stopped / live / listening(听) / thinking(思考) / speaking(讲解)，各有不同的呼吸球动画
const $ = (id) => document.getElementById(id);
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
  $('caption').textContent = t;
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
}
function setBookTitle() {
  $('bookTitle').textContent = currentBook ? currentBook.title : '未选择书';
}
const PALETTE = ['#7b6cf6', '#e0567a', '#2f9e6f', '#d98a2b', '#3a6ea5', '#8a5a44'];
function renderLibrary() {
  const books = loadBooks();
  const grid = $('bookGrid');
  grid.innerHTML = '';
  books.forEach((b, i) => {
    const c = document.createElement('div');
    c.className = 'book-card';
    c.style.background = `linear-gradient(160deg, ${PALETTE[i % PALETTE.length]}, rgba(0,0,0,0.4))`;
    c.innerHTML = `<div class="b-title">${esc(b.title)}</div>` + (b.author ? `<div class="b-author">${esc(b.author)}</div>` : '');
    c.onclick = () => {
      currentBook = b;
      localStorage.setItem('currentBook', b.id);
      resumeHandle = null; // 换书=新对话
      setBookTitle();
      $('booksPanel').hidden = true;
    };
    grid.appendChild(c);
  });
  const add = document.createElement('div');
  add.className = 'book-card add';
  add.innerHTML = '<div class="plus">＋</div><div>添加新书</div>';
  add.onclick = () => {
    $('booksPanel').hidden = true;
    openCoverScan();
  };
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
  const lang =
    langPref === 'zh'
      ? '请始终用中文回答（需要引用书里的英文原文时照引原文即可）。'
      : langPref === 'en'
      ? 'Always answer in English.'
      : '默认用读者提问所用的语言回答：他用中文问就用中文答，用英文问就用英文答。';
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
async function startCamera(deviceId) {
  try {
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' },
      audio: false,
    });
    video.srcObject = camStream;
    await video.play().catch(() => {});
    await listCameras();
    log('摄像头已开：' + (camStream.getVideoTracks()[0]?.label || '未知'));
  } catch (e) {
    log('摄像头错误：' + e.name + ' ' + e.message);
    setStatus('摄像头打开失败：' + e.name);
  }
}
async function listCameras() {
  const sel = $('cameraSelect');
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
  if (streaming) stopStream();
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  micStream = null;
  paused = true;
  $('pauseBtn').textContent = '▶';
  $('pauseBtn').title = '恢复摄像头和收音';
  $('pausedVeil').hidden = false;
  log('已暂停：摄像头与麦克风已关');
}
async function resumeMedia() {
  $('pausedVeil').hidden = true;
  $('pauseBtn').textContent = '⏸';
  $('pauseBtn').title = '暂停摄像头和收音';
  paused = false;
  try {
    await startCamera($('cameraSelect').value || undefined);
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
function saveNewBook(d) {
  const books = loadBooks();
  const book = { id: 'b' + Date.now(), title: d.title, author: d.author || '', background: bgText(d) };
  books.unshift(book);
  saveBooks(books);
  currentBook = book;
  localStorage.setItem('currentBook', book.id);
  resumeHandle = null;
  setBookTitle();
  exitCoverScan();
  caption(`已记下《${book.title}》${book.author ? ' / ' + book.author : ''}\n\n${d.summary || ''}`);
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
  exitCoverScan();
  caption('已建一本空书。对准封面后可重拍识别。');
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
    setStatus('请先在书柜里选一本书');
    $('booksPanel').hidden = false;
    renderLibrary();
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

// ---------- 菜单 / 设置 ----------
function setMode(m) {
  mode = m;
  $('modeLabel').textContent = m === 'explanation' ? '讲解' : '陪伴';
}

$('menuBtn').onclick = () => ($('menu').hidden = !$('menu').hidden);
$('menu').onclick = (e) => {
  const b = e.target.closest('button[data-action]');
  if (!b) return;
  $('menu').hidden = true;
  const a = b.dataset.action;
  if (a === 'library') {
    renderLibrary();
    $('booksPanel').hidden = false;
  } else if (a === 'settings') {
    listCameras();
    $('settingsPanel').hidden = false;
  } else if (a === 'mode') setMode(mode === 'companion' ? 'explanation' : 'companion');
};
document.addEventListener('click', (e) => {
  if (!$('menu').hidden && !$('menu').contains(e.target) && e.target !== $('menuBtn')) $('menu').hidden = true;
});
orb.addEventListener('click', onOrbTap);
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => ($(b.dataset.close).hidden = true)));
document.querySelectorAll('.overlay').forEach((ov) =>
  ov.addEventListener('click', (e) => {
    if (e.target === ov) ov.hidden = true;
  })
);
$('pauseBtn').onclick = togglePause;
$('resumeBtn').onclick = resumeMedia;
$('captureBtn').onclick = captureCover;
$('captureSkip').onclick = addBookBlank;
$('captureCancel').onclick = exitCoverScan;
$('replyLang').value = localStorage.getItem('replyLang') || 'auto';
$('replyLang').onchange = (e) => localStorage.setItem('replyLang', e.target.value);
$('cameraSelect').onchange = (e) => startCamera(e.target.value);
if (navigator.mediaDevices?.addEventListener) navigator.mediaDevices.addEventListener('devicechange', listCameras);

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

  const books = loadBooks();
  const cur = localStorage.getItem('currentBook');
  currentBook = books.find((b) => b.id === cur) || null;
  setBookTitle();

  try {
    await startCamera();
    setupAudioGraph();
    await attachMic();
  } catch (e) {
    log('初始化媒体失败：' + e.message);
    setStatus('需要摄像头/麦克风权限');
  }
  setState('stopped');
  renderLibrary();
  $('booksPanel').hidden = false; // 每次进入先落在「我的书柜」
})();
