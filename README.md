# 阅读陪伴 · Reading Companion

摄像头对着纸质书，实时语音陪你读：随问随答、像英语精读老师一样讲解。基于 **Gemini Live** 的实时多模态（实时看书页 + 语音对话 + 可打断）。网页版——手机浏览器即可用手机自己的摄像头。

## 运行

需要一个 Gemini API key（https://aistudio.google.com/apikey ）。

```bash
cp .env.example .env        # 然后把 GEMINI_API_KEY 填进去
npm install
npm run web
```

打开：

- 电脑：`https://localhost:5123`
- 手机（同一 Wi-Fi）：`https://<电脑局域网IP>:5123`
- 用量后台：`/dashboard`

自签 HTTPS 首次会提示"不安全"→ 继续访问（手机调摄像头必须是 HTTPS 安全上下文）。

## 手机访问需要 HTTPS（自签证书）

仓库不含证书。要在手机上用，先生成一份（把 IP 换成你电脑的局域网地址）：

```bash
mkdir -p certs && openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/key.pem -out certs/cert.pem -days 825 \
  -subj "/CN=reading-companion" \
  -addext "subjectAltName=IP:10.0.0.80,DNS:localhost,IP:127.0.0.1"
```

没有 `certs/` 时服务退回 HTTP，仅电脑 `localhost` 能调摄像头。

## 结构

- `server.mjs` — 后端：HTTPS + WebSocket 桥接到 Gemini Live + 封面识别 + 用量统计（API key 藏在这里）。
- `web/` — 前端：实时音视频客户端、呼吸球状态机、书柜、陪伴/讲解双模式、设置、用量后台页。

## 要点

- 实时大脑：Gemini Live（speech-to-speech，自带语音识别+发声，可打断）。
- 封面识别：Gemini Flash + Google 搜索 grounding（联网查这本书生成背景卡）。
- 控成本：唤醒后才开流、视频 0.5 帧/秒、讲完 5 秒无回应自动停流、上下文压缩。
- 书籍数据存浏览器 localStorage；用量统计存服务端 `data/usage.json`。
