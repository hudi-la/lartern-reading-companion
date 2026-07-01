-- 用量统计表：每个测试用户一行，累计 token / 时长 / 会话数。
-- 改了结构就更新这里，可重复执行（IF NOT EXISTS）。
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

-- 云端书库：每个用户一行，books 是整份书数组（和前端 localStorage 同构）。
-- 换设备、清浏览器缓存都不丢；服务端按登录用户名读写。
create table if not exists library (
  username   text primary key,
  books      jsonb       default '[]'::jsonb,
  updated_at timestamptz default now()
);
