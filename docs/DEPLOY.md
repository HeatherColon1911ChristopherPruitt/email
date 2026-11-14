# 部署教程

照着做，大约 20 分钟。需要：GitHub 账号、Cloudflare 账号、一个已经接入 Cloudflare 的域名。全程免费套餐，不需要绑卡。

本文与仓库代码一致：没有构建步骤，没有初始化接口，没有要手工执行的 SQL。

## 最短路径（域名已经在 Cloudflare）

| # | 做什么 | 在哪里 | 只填这一项 |
| --- | --- | --- | --- |
| 1 | 建 D1 | Storage & databases → D1 → Create | 名字 `temp-inbox`，建完复制 Database ID |
| 2 | 改配置 | 仓库里的 `wrangler.toml` | `database_id`、`MAIL_DOMAIN` |
| 3 | 推 GitHub | 本地 git | 仓库根目录就是 Worker 根目录 |
| 4 | 建 Worker | Workers & Pages → Create → Workers → Import a repository | Build command 留空，Deploy command `npx wrangler deploy` |
| 5 | 设密钥 | Worker → Settings → Variables and Secrets → Add | `ACCESS_KEY`，类型 **Secret** |
| 6 | 绑网站 | Worker → Settings → Domains & Routes → Add → Custom Domain | `inbox.你的域名` |
| 7 | 开收信 | 域名 → Email → Email Routing → Routing rules → Catch-all → Send to a Worker | 选 `temp-inbox`，置 Active |
| 8 | 验收 | 用真实邮箱发一封到 `test1234@你的域名` | 见第 7 节 |

第 7 步漏了，网站能开但永远收不到信。下面每一步展开说明。

---

## 0. 先确认一件事：域名现在有没有在收信

Email Routing 的全收规则会接管**整个域名**的所有地址。如果 `example.com` 现在挂着企业邮箱（Google Workspace、腾讯企业邮、Zoho 等），直接开全收会把这些邮箱的来信抢走。

- 域名没有在收信 → 直接用 `example.com`，邮箱形如 `任意前缀@example.com`。
- 域名已经在收信 → 换一个子域，比如 `mail.example.com`，邮箱形如 `任意前缀@mail.example.com`。下文所有 `example.com` 都替换成 `mail.example.com`。

网站地址和邮箱域名不需要是两个域名：网站用 `inbox.example.com`，邮箱用 `example.com` 是正常做法。

---

## 1. 建 D1 数据库

Cloudflare 控制台 → 左侧 **Storage & databases → D1 SQL database → Create**。

- Name：`temp-inbox`（名字随意，但要和 `wrangler.toml` 里的 `database_name` 一致）
- 创建后复制页面上的 **Database ID**（一串 UUID）

表不用手工建。程序第一次被访问时会自动建 `messages`、`images`、`meta` 三张表，重复执行不会删数据。

---

## 2. 把代码放到自己的 GitHub

Cloudflare 从 GitHub 拉代码来构建和部署，所以要先有一份你能改的副本。

1. Fork 本仓库，或者新建一个空仓库把代码推上去。私有仓库也可以。
2. 改 `wrangler.toml` 两处：

```toml
[[d1_databases]]
binding = "db"
database_name = "temp-inbox"
database_id = "把第 1 步复制的 UUID 贴在这里"

[vars]
MAIL_DOMAIN = "example.com"   # 换成你的域名，不带 @
```

3. 提交。

`MAIL_DOMAIN` 支持多域名，英文逗号分隔，例如 `"example.com,mail.example.com"`。每个域名都要单独做第 6 步。

> 只改这一个文件。`ACCESS_KEY` 不要写进仓库，第 4 步在控制台加。

---

## 3. 创建 Worker 并连上仓库

控制台 → **Workers & Pages → Create application → Workers → Import a repository**（有的界面叫 Connect to Git）。

| 字段 | 填什么 |
| --- | --- |
| Git account / Repository | 选第 2 步的仓库 |
| Production branch | `main` |
| Root directory | 留空（`wrangler.toml` 在仓库根目录） |
| Build command | **留空** |
| Deploy command | `npx wrangler deploy` |

点 Deploy。第一次构建大约 1 分钟，日志里会出现 `Uploaded temp-inbox`。

构建失败常见原因：`database_id` 还是占位符、`MAIL_DOMAIN` 拼错、仓库根目录不是 `wrangler.toml` 所在目录。

---

## 4. 设置访问密钥

Worker → **Settings → Variables and Secrets → Add**。

- Type：**Secret**（不是 Text，Text 会明文显示在页面和日志里）
- Name：`ACCESS_KEY`
- Value：随机生成一串，别用能猜到的

生成命令：

```bash
openssl rand -hex 24
```

保存后立即生效，不需要重新部署。这串密钥后面网页和程序都要用，先存到密码管理器。

**同一个页面里不要加**别的变量，`MAIL_DOMAIN` 和 `RETENTION_HOURS` 已经在 `wrangler.toml` 里了。

---

## 5. 绑定网站域名

Worker → **Settings → Domains & Routes → Add → Custom Domain**。

- Domain：`inbox.example.com`
- Cloudflare 会自动创建 DNS 记录，等状态变成 Active

之后打开 `https://inbox.example.com` 就是收件页面。

**这一步和发邮件无关**。网站能打开不代表能收信，收信靠下一步。

---

## 6. 开启邮件路由（关键）

控制台 → 选中你的域名 → 左侧 **Email → Email Routing**。

1. 点 **Get started** / **Enable Email Routing**。
2. Cloudflare 会自动添加 MX 和 SPF/DKIM 的 TXT 记录。如果它提示"已有 MX 记录冲突"，说明这个域名现在在别处收信 —— 回到第 0 步改用子域。
3. 进入 **Routing rules**，找到 **Catch-all address**，点 Edit。
4. Action 选 **Send to a Worker**，Worker 选 `temp-inbox`，Save。
5. Catch-all 开关置为 **Active**。

这一步做完，`任意前缀@example.com` 的来信都会交给这个 Worker。不需要为每个地址建规则，全收规则一条就够。

验证配置是否生效：

```bash
dig +short MX example.com
```

应该能看到 `route1.mx.cloudflare.net` 之类的记录。

---

## 7. 验收

按顺序做，每步都能独立判断成败。

1. **网站能打开**：访问 `https://inbox.example.com`，出现"输入访问密钥"。
2. **密钥正确**：粘贴第 4 步的 `ACCESS_KEY`，点连接，右上角变"已连接"，显示邮箱域名。
3. **密钥错误有明确提示**：故意输错一次，应该显示"密钥不正确"，而不是"没有邮件"。
4. **真实收信**：用你自己的邮箱（QQ、Gmail 都行）给 `test1234@example.com` 发一封信，正文写"验证码 834621"。
5. **网页能查到**：网页前缀填 `test1234`，点"查询"，应该看到这封信，验证码显示 834621。
6. **能看原文**：点这封信，正文在右侧渲染出来。
7. **程序能取码**：

```bash
curl -s "https://inbox.example.com/api/messages?address=test1234@example.com" \
  -H "Authorization: Bearer 你的密钥"
```

返回里应该有 `"code": "834621"` 和邮件 `id`。

8. **能删除**：

```bash
curl -s -X DELETE "https://inbox.example.com/api/messages/1" \
  -H "Authorization: Bearer 你的密钥"
```

返回 `{"id":1,"deleted":true}`，再查列表应该没有了。

9. **数据库真的写进去了**：控制台 → D1 → `temp-inbox` → Tables，能看到 `messages`、`images`、`meta`。

第 4 步收不到信，看下一节。

---

## 8. 收不到信怎么查

按这个顺序排除，每一步都能定位到具体环节。

| 现象 | 检查 | 结论 |
| --- | --- | --- |
| 网页打不开 | `dig +short inbox.example.com` 有没有解析结果 | 没有 → 第 5 步域名没绑上 |
| 网页能开，查询返回"地址必须属于本服务" | `MAIL_DOMAIN` 和实际邮箱域名是否一致 | 不一致 → 改 `wrangler.toml` 重新部署 |
| 发信方立即退信 "Recipient not found" | Email Routing 的 Catch-all 是否为 Active | 没生效 → 重做第 6 步 |
| 发信方退信，提示 MX 指向别处 | `dig +short MX example.com` | 还是旧 MX → 等 DNS 生效，或域名确实在别处收信，改用子域 |
| 邮件"发送成功"但列表一直空 | Worker 日志（Settings → Logs / Observability）有没有 `邮件解析失败`、`邮件入库失败` | 有报错 → 看下一条 |
| 日志出现 `EXCEEDED_CPU` | 这封信接近或超过 1 MiB | 已按设计放弃正文，列表里会出现"超出大小限制"的记录 |
| 列表里有记录但正文空白 | 记录 `status` 是 `too_large` | 同上，不是故障 |
| 列表里有信，但验证码为空 | 打开原文看是不是图片码或链接验证 | 规则提取不到就是空，不是没收到 |

日志入口：Worker → **Logs**（或 Observability → Logs），按时间倒序看最近的 `console.error`。

---

## 9. 日常维护

**换访问密钥**：第 4 步重新录一个 `ACCESS_KEY`。旧密钥立即失效，网页需要重新输入。

**升级代码**：改完推 GitHub，Workers 会自动重新构建部署。建表语句是 `CREATE TABLE IF NOT EXISTS`，重复部署不会清空邮件。

**看用量**：控制台 → Workers → 你的 Worker → Metrics；D1 → 数据库 → Metrics。免费额度到顶时，收信会失败并在日志里留痕，不会伪装成"没有邮件"。

**手动清一次过期邮件**（一般不需要，每小时自动清）：

```bash
curl -s -X POST "https://inbox.example.com/api/cleanup" \
  -H "Authorization: Bearer 你的密钥"
```

---

## 10. 想删掉整套服务

1. Email Routing → Catch-all 规则删掉或改回别的动作（否则来信会被丢进一个不存在的 Worker）。
2. Worker → Settings → Delete。
3. D1 → `temp-inbox` → Delete。
4. 需要的话把 MX 记录改回原来的邮箱服务商。
