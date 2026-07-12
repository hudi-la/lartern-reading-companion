# 资源与运维地图 · Operations

> 这份文档记「东西都在哪、怎么连起来的」——部署、数据库、密钥、登录、上线流程。
> 具体的 Supabase 建表步骤见 [SUPABASE_SETUP.md](SUPABASE_SETUP.md)，本地跑法见 [README.md](README.md)。
> **本文件不含任何密钥**，只写密钥「叫什么、在哪拿、填哪」。

## 一句话

摄像头对着纸质书，基于 **Gemini Live** 实时语音陪读（看书页 + 语音对话 + 可打断）。
网页版，手机浏览器直接用手机摄像头。带后端（藏 API key、记用量、云端书库）。

## 代码仓库

- GitHub：`github.com/hudi-la/reading-companion`，主分支 `main`
- `server.mjs` — 后端：Express + WebSocket 桥到 Gemini Live + 封面识别 + 用量统计（Node ≥20）
- `web/` — 前端：`index.html` / `app.js` / `styles.css` / `login.html`（登录页）/ `dashboard.html`（用量后台）

## 部署 · Render

| 项 | 值 |
|---|---|
| 平台 | **Render** |
| 服务名 | `reading-companion` |
| 线上地址 | https://reading-companion.onrender.com |
| 用量后台 | `/dashboard` |
| 部署方式 | **push 到 `main` 自动重新部署**（Render 连着 GitHub） |
| 构建 / 启动 | `npm install` → `npm start`（即 `node server.mjs`） |
| 档位 | 免费档：**约 15 分钟无访问会休眠**，冷启动约 30–60 秒；硬盘会清零（所以用量必须存 Supabase） |
| HTTPS | 平台自动终结 TLS；服务端在反代后走 HTTP，靠 `trust proxy` + `x-forwarded-proto` 识别 https（[server.mjs:329](server.mjs#L329)、[:470](server.mjs#L470)） |

**上线一个新版本：** `git push origin main` → 去 Render 控制台看有条新 deploy → 状态 **Live** 即成。

## 数据 · Supabase

| 项 | 值 |
|---|---|
| 项目名 | **reading assistant** |
| 项目 ref | `jjgvvtrsnoqnoigukobi` |
| Project URL | `https://jjgvvtrsnoqnoigukobi.supabase.co`（= 环境变量 `SUPABASE_URL`） |
| 区域 | us-east-2 |

**4 张表**（都以 `username` 为主键；后端用 service_role key 读写，绕过 RLS）：

| 表 | 存什么 |
|---|---|
| `usage` | 每个用户的 token 用量、时长、会话数 |
| `library` | 每个用户的云端书库（`books` jsonb 数组，换设备/清缓存不丢） |
| `reader_profile` | 读者画像（`seed` onboarding 选的 + `learned` 学到的） |
| `book_memory` | 每本书的想法/记忆（`data` jsonb） |
| `user_secrets` | 每个用户加密后的 Gemini key（`gemini_key_enc`，AES-256-GCM） |
| `accounts` | 账号登记（谁注册了、`last_seen`） |

> ⚠️ 一旦后端设了 `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`，这 4 块**全部只走 Supabase、不再回落本地文件**。缺表 = 那块数据静默丢失（不崩）。当前 4 张表都在、有真实数据。
> （项目里还有 `cw_books` / `cw_universal` 两张表，是**别的项目**的，与本 app 无关。）

没配 Supabase 时（如纯本地跑），自动退回本地文件 `data/*.json`，仅本地有效。

## 登录 · 访问控制

两种模式，代码按环境变量自动选（缺新变量就回退旧邀请码，部署永远不崩）：

**① 邮箱验证码（目标模式）** — 齐了 `SUPABASE_URL`+`SUPABASE_ANON_KEY`+`SESSION_SECRET` 就启用。
- 流程：`/login` 输邮箱 → Supabase 发 6 位码 → 输码 → 后端设**签名 cookie**（`rc_auth = base64url(邮箱).HMAC`，防伪造）。身份=邮箱。
- 开放自助：任何邮箱都能注册。护栏靠 **BYOK**（见下），不是靠邀请。
- 端点：`POST /auth/request`、`POST /auth/verify`、`POST /logout`、`GET /me`。
- `/usage`、`/dashboard` 邮箱模式下**仅 `OWNER_EMAILS` 可见**（用户名=邮箱，不能泄露给自助注册的人）。

**② 邀请码（回退模式）** — 没配上面三个变量时启用。`ACCESS_USERS="名字:码,..."`，`/login` 输码即进。

- Cookie `rc_auth`（30 天）。除 `/login`、`/status` 外所有路径都要鉴权。
- 本地调试彩蛋：`localhost/?as=test1` 切全新空账号（**仅 localhost，线上忽略**）。

## BYOK · 自带 Gemini key

- 邮箱模式下**每个用户必须填自己的 Gemini key 才能用**（没 key 挡在填 key 页）——这是开放自助的成本护栏，别人烧的是自己的 key。
- 你自己（`OWNER_EMAILS` 里的邮箱）无 key 时回落到全局 `GEMINI_API_KEY`，不用粘。
- key 用 **AES-256-GCM 加密**存 `user_secrets` 表（密钥来自 `APP_ENC_KEY`），前端只显示"已设置/未设置"，永不回显。
- 后端按登录用户取各自的 key 跑 Gemini Live / 封面识别 / 进度总结。
- 管理：设置面板可设置/替换/清除；端点 `PUT /key`（存前做极小调用校验）、`DELETE /key`。

## 环境变量总表

在 **Render 控制台 → 服务 → Environment** 配；本地放 `.env`（已 gitignore，不入库）。**值都不写在这**。

| 变量 | 必需 | 是什么 / 在哪拿 |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | 全局 Gemini key（仅 `OWNER_EMAILS` 回落用），https://aistudio.google.com/apikey |
| `SUPABASE_URL` | ✅ | `https://jjgvvtrsnoqnoigukobi.supabase.co` |
| `SUPABASE_SERVICE_KEY` | ✅ | Supabase → Settings → API → **service_role** key（机密） |
| `SUPABASE_ANON_KEY` | ✅(邮箱登录) | Supabase → Settings → API → **anon/publishable** key（发验证码用，非机密） |
| `SESSION_SECRET` | ✅(邮箱登录) | 会话 cookie 签名密钥，`openssl rand -hex 32` 生成 |
| `APP_ENC_KEY` | ✅(邮箱登录) | 加密用户 key 的密钥，`openssl rand -hex 32` 生成。**改了会导致已存的 key 全部解不开** |
| `OWNER_EMAILS` | 建议 | 你自己的邮箱（逗号分隔）：无 key 回落全局 key + 能看 `/dashboard` |
| `ACCESS_USERS` | 回退用 | 邀请码模式。配了邮箱三件套后可留可删（邮箱模式优先） |
| `GEMINI_LIVE_MODEL` | 可选 | 默认 `gemini-3.1-flash-live-preview` |
| `GEMINI_VISION_MODEL` | 可选 | 默认 `gemini-2.5-flash` |

> **Supabase 一次性配置（邮箱验证码必需）**：Dashboard → Authentication →
> ① Providers 里 **Email** 开着、允许新用户注册；
> ② Email Templates → **Magic Link** 模板里加入 `{{ .Token }}`（否则邮件只有链接、没有 6 位码）。

## 成本参考

代码里的计价（$/百万 token，[server.mjs:83](server.mjs#L83)）：
输入文本 0.75 / 输入音频 3 / 输入视频 1 / 输出文本 4.5 / 输出音频 12。
`/dashboard` 可按用户看累计用量与花费。

## 三个账号，别记混

| 账号 | 管什么 | 密钥放哪 |
|---|---|---|
| **Google AI Studio** | Gemini API key（烧钱的那个） | Render `GEMINI_API_KEY` |
| **Render** | 托管、自动部署、环境变量 | 控制台登录 |
| **Supabase**（项目 reading assistant） | 用量/书库/画像/记忆 4 张表 | service_role key → Render `SUPABASE_SERVICE_KEY` |
