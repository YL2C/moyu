# 墨游 · 服务器转发（后台生成）方案

> 给执行的人（和 AI）：先把这份读完，再读 `README.md` 和 `js/api.js`、`js/views/play.js`。
> 改代码前先 `git pull`，只改需要改的地方；推送前把 `sw.js` 的缓存名和 `js/util.js` 的 `APP_VERSION` 各加一版。

## 0. 要解决什么

墨游是纯前端网页：手机切到别的 App、锁屏，iOS 会暂停网页，正在生成的那一章就断了。
目标：**请求由服务器替手机发，服务器把模型写出来的东西存着**。手机切走、锁屏、甚至关掉页面都不影响；回来以后接着显示，已经写完的直接拿到。

不做的事：故事、存档、设定**仍然只存在手机里**；服务器不存故事，只临时存“这一次生成的原始返回”，30 分钟后删除。

## 1. 先确认三件事（决定后面怎么做）

1. **服务器地区**。大陆机房连不上 Google / Anthropic / OpenAI 官方接口，只有国内能访问的中转站能经服务器转发；Vertex（Google）就只能继续直连。香港 / 海外机房没有这个限制。
2. **HTTPS**。墨游网页是 `https://lishbuwe.github.io/moyu/`，浏览器不允许它请求 `http://` 地址。服务器必须有 `https://` 地址，三选一：
   - 有域名：用 Caddy（自动申请证书，最省事）或 nginx + certbot。大陆机房的域名需要备案。
   - 没域名：Cloudflare Tunnel（需要一个托管在 Cloudflare 的域名；临时测试可用 `cloudflared tunnel --url`，但地址每次重启会变）。
   - 不推荐：自签证书（iPhone 上很麻烦）。
3. **端口不要和酒馆冲突**（酒馆默认 8000）。本方案用 `8787`，只监听 `127.0.0.1`，由 Caddy / nginx / 隧道对外提供 https。

## 2. 服务器程序（`server/relay.mjs`，Node 18+，不装依赖）

### 2.1 工作方式

它是一个**带缓存的通用转发器**：不理解模型协议，只把“墨游原本要发的那个请求”原样发出去，把上游返回的字节原样存下来，再按需吐给手机。这样墨游解析返回的代码一行都不用改。

### 2.2 接口

所有请求都要带头 `Authorization: Bearer <RELAY_TOKEN>`，不对返回 401。全部支持 CORS（`Access-Control-Allow-Origin` 只放行 `https://lishbuwe.github.io`，以及 `RELAY_ORIGINS` 环境变量里额外列的地址），并处理 `OPTIONS` 预检。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | 不要口令；返回 `{ ok: true, version }`，用来测通 |
| POST | `/jobs` | 新建一个转发任务，立刻返回 `{ id }` |
| GET | `/jobs/:id/stream?from=0` | 从第 `from` 个字节开始，把上游返回的原始字节流给手机；任务还在写就一直流下去，写完就结束 |
| GET | `/jobs/:id` | 查状态：`{ state: 'running'|'done'|'error', upstreamStatus, contentType, bytes, error }` |
| DELETE | `/jobs/:id` | 取消（墨游点“停止”时调用），同时中断上游请求 |

`POST /jobs` 的请求体：

```json
{ "url": "https://上游地址/v1/chat/completions", "method": "POST", "headers": { "Authorization": "Bearer sk-…", "Content-Type": "application/json" }, "body": "原样的请求体字符串" }
```

### 2.3 规则

- 任务在内存里：`{ id, state, upstreamStatus, contentType, chunks: Buffer[], bytes, createdAt, abort }`。id 用 `crypto.randomUUID()`。
- 收到任务就**立刻**用 `fetch` 去请求上游（不等手机来拿），边收边追加到 `chunks`，同时推给正在 `stream` 的连接（可能有多个，也可能一个都没有）。
- `GET /jobs/:id/stream` 的响应：状态码固定 200；头里带 `X-Upstream-Status`（上游状态码）、`X-Upstream-Content-Type`（上游 content-type）、`X-Job-State`；body 是从 `from` 开始的原始字节，任务没结束就保持连接、继续写。上游出错（4xx/5xx）也照样把上游返回的错误内容原样给出。
- 任务结束后保留 **30 分钟**，然后删掉；同时最多 20 个任务，单个返回最多 5 MB；请求体最多 2 MB。
- **安全**：不记录请求体、不记录 headers（里面有用户的密钥）；日志只记 `id、上游域名、状态码、字节数、耗时`。`url` 只允许 `https://`，拒绝内网地址（`localhost`、`127.*`、`10.*`、`172.16–31.*`、`192.168.*`、`169.254.*`），防止被当成跳板。
- 口令和端口从环境变量读：`RELAY_TOKEN`（必填，随机 32 位以上）、`PORT`（默认 8787）、`HOST`（默认 127.0.0.1）。

### 2.4 部署

```bash
# 服务器上
cd ~ && git clone https://github.com/lishbuwe/moyu.git && cd moyu/server
export RELAY_TOKEN=$(openssl rand -hex 24) && echo "口令：$RELAY_TOKEN"   # 记下来，填到墨游里
# 用 systemd 常驻（写一个 moyu-relay.service，Environment= 里放 RELAY_TOKEN），或者用 pm2
```

Caddy 示例（有域名时）：

```
relay.你的域名.com {
  reverse_proxy 127.0.0.1:8787 {
    flush_interval -1      # 流式返回不要缓冲
  }
}
```

nginx 的话要加 `proxy_buffering off; proxy_read_timeout 600s;`。

在 `server/README.md` 里写清楚上面这些步骤和怎么更新（`git pull` 后重启服务）。

## 3. 墨游这边要改的

### 3.1 设置

- 设置页加一节「服务器转发（可选）」：地址（https://…）、口令、「测试」按钮（调 `/health`，再带口令调一次 `GET /jobs/不存在的id` 应得 404 而不是 401）。存在 kv 里，键名 `relay`：`{ url, token, on }`。**口令和密钥一样，导出备份时不带出去**（看 `js/db.js` 的 `exportAll`）。
- 每个连接加一个开关「经服务器转发」（`conn.viaRelay`），默认关。Vertex 连接如果服务器在大陆，提示“大陆服务器连不上 Google，建议直连”。

### 3.2 `js/api.js`

只动 `streamChat` 里发请求的那一处（现在是 `res = await fetch(url, { method: 'POST', headers, body, signal })`）：

- 连接开了转发且全局转发可用时，改成调用新函数 `relayFetch(url, init, { onJob })`，它返回一个**和 fetch 一样的 Response**（`new Response(stream, { status: X-Upstream-Status, headers: { 'content-type': X-Upstream-Content-Type } })`），后面的解析代码完全不变。
- `relayFetch`：先 `POST /jobs` 拿 id，调 `onJob(id)`，再 `GET /jobs/:id/stream?from=0` 拿流。
- 停止：`signal` 中断时，除了断开自己的流，还要 `DELETE /jobs/:id`。
- `streamChat` 增加一个可选参数 `resumeJob`：传了就不新建任务，直接 `GET /jobs/<resumeJob>/stream?from=0` 从头拿一遍（从 0 开始最简单：重新解析一遍就得到完整内容）。
- 转发服务器本身连不上时（网络错误、401），报一个清楚的错：“连不上转发服务器”，并提示可以在连接里关掉“经服务器转发”改直连。
- `listModels`、测试连接可以继续直连，不强制走转发。

### 3.3 `js/views/play.js`（这才是“后台跑”真正生效的地方）

- 生成开始时，`onJob(id)` 回调里把 `a.relayJob = id` 写进这一章的节点并保存（`db.put('nodes', a)`）。
- 现在页面加载时会把 `status === 'streaming'` 的章标成“中断”（文件开头那段循环）。改成：**如果这一章有 `relayJob`，先不要标中断**，而是调用 `streamChat(..., { resumeJob })` 接上，用原来的 `onText` 更新这一章；任务已经不存在（404，超过 30 分钟）才按原来的逻辑标成中断。
- 回到前台时（`document.visibilitychange` 变成 visible），如果当前有一章在生成但流已经断了，也用同样的方法从 `from=0` 重新接上。
- 生成正常结束后清掉 `a.relayJob`。
- `js/memory.js`（整理前情）、`js/views/extras.js`（番外）、`js/discuss.js`（讨论）先不用接 `resumeJob`，只要经转发发出去就行（它们断了就重试，影响小）。第二步再加。

### 3.4 测试

仓库里没有测试代码。至少手工测这几样：
1. 开转发，正常玩一章，内容、弹幕、选项、花费都和直连一样。
2. 生成到一半切到别的 App 半分钟再回来：接着显示，写完的部分不丢。
3. 生成到一半直接关掉网页，过一会儿再打开：那一章自动接上并写完。
4. 点“停止”：服务器上的任务也停了（`GET /jobs/:id` 显示不是 running）。
5. 关掉服务器：报“连不上转发服务器”，关掉连接的转发开关后直连照常能用。
6. 导出备份里没有口令。

## 4. 之后可以加的（按价值排序，都可选）

1. **写完了推送通知**：iPhone 上把墨游“添加到主屏幕”后支持网页推送。服务器在任务写完时发一条“第 N 章写好了”。需要 VAPID 密钥和 `web-push` 逻辑（可以手写，不一定装库）。
2. **云端备份 / 换设备**：手机上把“导出全部”的内容**先加密**（密码只有用户知道，用 WebCrypto AES-GCM），再传到服务器存一份；在 Mac 上输密码拉下来。服务器只看得到密文。顺便可以做“每天自动备份一次”。
3. **整理前情、番外、讨论也支持断线接上**（3.3 最后一条）。
4. **用量统计放服务器**：多台设备的花费合在一起看。
5. **Vertex 服务账号放服务器**（仅限海外机房）：手机里不再存那份权限很大的 JSON，由服务器换令牌。
