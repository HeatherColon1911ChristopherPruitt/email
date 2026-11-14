# 接口说明

服务地址就是你部署的网站地址，例如 `https://inbox.example.com`。网页和程序用同一套接口。

## 认证

所有 `/api/*` 请求都要带访问密钥，放在请求头里，两种写法等价：

```
Authorization: Bearer <ACCESS_KEY>
X-Access-Key: <ACCESS_KEY>
```

- 密钥在 Cloudflare 控制台配置（`ACCESS_KEY`，类型 Secret），不写在仓库里。
- 密钥错误返回 `401`，与"没有邮件"严格区分。
- 例外：图片地址 `/i/{token}/{seq}` 不带请求头，见第 5 节。
- 允许跨域：返回 `Access-Control-Allow-Origin: *`，前端可以直接从别的域调用。

## 返回格式

成功返回 JSON。失败统一为：

```json
{ "error": { "code": "not_found", "message": "邮件不存在，或已删除、已过期。" } }
```

| code | HTTP | 含义 | 该怎么做 |
| --- | --- | --- | --- |
| `unauthorized` | 401 | 密钥缺失或错误 | 修密钥，不要重试 |
| `not_configured` | 503 | 部署者没设 `ACCESS_KEY` | 让部署者补配置 |
| `invalid_address` | 400 | 地址缺失、格式不对、不属于本服务域名 | 检查地址和 `MAIL_DOMAIN` |
| `bad_request` | 400/405 | 参数或方法不对 | 按文档改请求 |
| `not_found` | 404 | 邮件不存在 / 已删除 / 已过期 | 不要重试，去列表确认 |
| `server_error` | 500 | 服务内部错误 | 可以有限次重试，并记录响应 |

## 时间

所有时间都是 **毫秒时间戳**（`Date.now()` 同单位）。

服务端时间以接口返回的 `serverTime` 为准，不要用本机时间做起点判断——两边时钟可能差几秒。

---

## 1. `GET /api/status`

检查密钥和服务，拿到邮箱域名和固定规则。

```bash
curl -s https://inbox.example.com/api/status \
  -H "Authorization: Bearer $INBOX_KEY"
```

```json
{
  "ok": true,
  "domain": "example.com",
  "domains": ["example.com"],
  "serverTime": 1794676833940,
  "retentionHours": 24,
  "limits": {
    "maxRawBytes": 1048576,
    "maxImages": 8,
    "maxImageBytes": 262144,
    "pageSizeMax": 50,
    "pageSizeDefault": 20
  },
  "wait": { "intervalMs": 5000, "maxMs": 180000 }
}
```

`wait` 只是建议值，服务端不会替你轮询。

## 2. `GET /api/messages`

按地址查邮件。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `address` | 是 | 完整地址，如 `abc@example.com`。只写前缀会返回 400 |
| `since` | 否 | 只返回接收时间 ≥ 该毫秒时间戳的邮件，用于"本次发码范围" |
| `after` | 否 | 只返回 id > 该值的邮件，按时间正序返回，用于"继续查新来信" |
| `before` | 否 | 只返回 id < 该值的邮件，按时间倒序返回，用于翻更早的页 |
| `limit` | 否 | 条数，默认 20，最大 50 |
| `from` | 否 | 按发件人地址模糊匹配，最长 40 字 |
| `subject` | 否 | 按主题模糊匹配，最长 40 字 |

不带 `after` 时按接收时间**倒序**（最新的在前）；带 `after` 时按**正序**（最早的在前，方便顺序处理）。

```bash
curl -s "https://inbox.example.com/api/messages?address=abc@example.com&since=1794676833940" \
  -H "Authorization: Bearer $INBOX_KEY"
```

```json
{
  "address": "abc@example.com",
  "count": 2,
  "cursor": 12,
  "messages": [
    {
      "id": 12,
      "address": "abc@example.com",
      "from": "no-reply@acme.test",
      "fromName": "Acme",
      "subject": "你的登录验证码",
      "code": "834621",
      "receivedAt": 1794676870000,
      "expiresAt": 1794763270000,
      "hasHtml": true,
      "images": 1,
      "status": "ok"
    }
  ],
  "serverTime": 1794676900000
}
```

字段含义：

- `code`：提取到的验证码，**可能是空字符串**。空表示"收到信了但没提取到"，不是没收到。
- `status`：`ok` 正常；`too_large` 邮件超过大小上限，只记录了收件事实，没有正文。
- `images`：内嵌图片数量。
- `cursor`：本次返回的最大 id，没有结果时为 `null`。

## 3. `GET /api/messages/{id}`

看一封邮件。正文里的内嵌图片已经改写成可访问的站内地址。

```bash
curl -s https://inbox.example.com/api/messages/12 \
  -H "Authorization: Bearer $INBOX_KEY"
```

```json
{
  "id": 12,
  "address": "abc@example.com",
  "from": "no-reply@acme.test",
  "fromName": "Acme",
  "subject": "你的登录验证码",
  "code": "834621",
  "receivedAt": 1794676870000,
  "expiresAt": 1794763270000,
  "hasHtml": true,
  "status": "ok",
  "rawSize": 12000,
  "text": "您的验证码是 834621，5 分钟内有效。",
  "html": "<div>…<img src=\"/i/9f3c…/1\"></div>",
  "images": [
    { "seq": 1, "contentType": "image/png", "size": 4021, "url": "/i/9f3c…/1" }
  ]
}
```

邮件被删除、过期或从来没存在过，一律返回 `404 not_found`——这个区别对调用方没有意义。

## 4. `DELETE /api/messages/{id}`

删除一封邮件和它的图片。重复调用是安全的。

```bash
curl -s -X DELETE https://inbox.example.com/api/messages/12 \
  -H "Authorization: Bearer $INBOX_KEY"
```

```json
{ "id": 12, "deleted": true }
```

已经不存在时返回 `{"id": 12, "deleted": false}`，HTTP 仍是 200，调用方不需要为"已经删过"报错。

验证成功后应该删掉这封邮件：删信失败不要回滚外部验证结果，到期清理会兜底。

## 5. 图片 `GET /i/{token}/{seq}`

邮件正文里的 `<img>` 已经指向这个地址，**不需要请求头**（浏览器加载图片无法附带自定义头）。

- `token` 是随邮件生成的 32 位随机串，只能访问这一封邮件的图片。
- 邮件删除或过期后，地址立即返回 404。
- 响带有 `X-Content-Type-Options: nosniff` 和 `Content-Security-Policy: default-src 'none'; sandbox`。
- 图片不会留下独立永久链接，随邮件一起清理。

`/api/messages/{id}` 返回的 `images[].url` 是相对路径，拼上服务地址即可。

## 6. `POST /api/cleanup`

手动触发一次过期清理，验证和排查用。正常情况每小时自动清理，不需要调用。

```json
{ "removed": 3 }
```

---

## 程序取码的推荐写法

核心是两点：**发信前记下起点**、**成功后删掉**。

```js
const BASE = 'https://inbox.example.com';
const KEY = process.env.INBOX_KEY;
const headers = { authorization: `Bearer ${KEY}` };

// 1. 每次任务用新地址，避免旧邮件干扰
const address = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`;

// 2. 发信之前记下服务端起点（先取一次 serverTime，避免本机时钟偏差）
const status = await (await fetch(`${BASE}/api/status`, { headers })).json();
const since = status.serverTime;

// 3. 把 address 填到目标网站，让它发信

// 4. 轮询本次范围
let found = null;
for (let i = 0; i < 24; i += 1) {          // 约 2 分钟
  const url = `${BASE}/api/messages?address=${encodeURIComponent(address)}&since=${since}&limit=10`;
  const data = await (await fetch(url, { headers })).json();

  if (data.messages?.length) {
    const withCode = data.messages.find((m) => m.code);
    if (withCode) { found = withCode; break; }
    // 收到信但没有码：可能是链接验证或图片码，需要人工介入
    console.log('收到邮件但无验证码', data.messages.map((m) => m.subject));
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}

if (!found) throw new Error('没有取到验证码');

// 5. 用 found.code 完成外部验证，成功后再删除
await fetch(`${BASE}/api/messages/${found.id}`, { method: 'DELETE', headers });
```

其它注意点：

- **不要用同一地址跑多个任务**。不同任务用不同前缀，否则会互相干扰。
- **不要因为收到旧邮件就重试外部验证**。被目标网站拒绝过的验证码不要再提交。
- **删除失败不要重做验证**。外部验证已经成功，删信只是清理，交给到期清理也行。
- **`since` 用服务端时间**。本机快 3 秒就永远查不到这 3 秒内到的信。
