# Supabase 用量存储 · 一次性设置

按用户分开记用量的数据存在 Supabase（Postgres）。Render 免费版硬盘会清零，所以必须用外部库。
没配 Supabase 时代码会自动退回本地文件 `data/usage.json`（仅本地有效），不会崩。

## 1. 建项目

1. 去 https://supabase.com 注册、新建一个免费 project（地区选离你近的）。
2. 进项目后，左侧 **Settings → API**，记下两样：
   - **Project URL**（形如 `https://xxxx.supabase.co`）→ 填环境变量 `SUPABASE_URL`
   - **service_role** 那个 key（不是 anon）→ 填环境变量 `SUPABASE_SERVICE_KEY`
     ⚠️ service_role 能绕过权限读写，是机密，只放服务器、别进 Git、别放前端。

## 2. 建表

左侧 **SQL Editor** → New query，粘贴执行：

```sql
create table if not exists usage (
  username     text primary key,
  in_text      bigint      default 0,
  in_audio     bigint      default 0,
  in_video     bigint      default 0,
  out_text     bigint      default 0,
  out_audio    bigint      default 0,
  streaming_ms bigint      default 0,
  sessions     integer     default 0,
  started_at   timestamptz,
  updated_at   timestamptz default now()
);
```

## 3. 配环境变量

**本地**：在 `.env` 里加
```
ACCESS_USERS=alice:邀请码A,bob:邀请码B
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...（service_role）
```

**Render**：控制台 → 你的服务 → Environment，加同样三个变量（值同上），保存会自动重新部署。

## 4. 验证

- 启动后日志会打印 `用量已从 Supabase 载入：N 个用户`。
- 用某个邀请码登录、唤醒说几句、停下；回 `/dashboard`，顶部下拉能按用户切换看用量。
- 在 Supabase 的 **Table Editor → usage** 里能看到对应用户的行在增长。

## 给测试者发什么

每人发**一个邀请码**（就是 `ACCESS_USERS` 里冒号后面那串）。他们在登录页输码即可，
彼此用量自动分开。想停用某人：把 `ACCESS_USERS` 里他那段删掉，重新部署即可。
