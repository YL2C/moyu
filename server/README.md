# 墨游转发服务

正文请求由服务器持续执行，手机断线后按任务编号重新取回原始返回。任务及原始返回仅在内存中，完成后最多保留 30 分钟。缓存满时旧结果可能提前清理，服务重启会丢失未取回的任务。故事、设定、存档仍在设备上。

先确认服务器实际地区、HTTPS 和端口。请以实例控制台的“地域”为准，云厂商名称不能代表机房地区。大陆机房建议仅转发国内可达的中转站；香港及海外机房也要实测目标 API 的网络和地区限制。

## 已有 Docker 的服务器

使用 Node 官方镜像，无 npm 依赖。不要改动正在运行的酒馆容器。

```sh
git clone https://github.com/lishbuwe/moyu.git
cd moyu/server
umask 077
openssl rand -hex 24 | sed 's/^/RELAY_TOKEN=/' > .env
docker compose up -d
curl -fsS http://127.0.0.1:8787/health
```

首次创建 `.env`，已有文件不要重建，否则会更换口令。文件内的 `RELAY_TOKEN` 填入墨游设置；不要提交、截图或放进网址里。`.env` 已被 Git 忽略。也可在 `.env` 添加 `RELAY_ORIGINS=https://另一个网页来源`，多个来源用逗号分隔，不要带路径。默认只允许 `https://lishbuwe.github.io`。

容器内监听 `0.0.0.0:8787`，Docker 只把它映射到宿主机的 `127.0.0.1:8787`，不需要在云防火墙放行 8787。

## HTTPS

推荐给转发器单独使用一个 HTTPS 子域名，指向此服务器。可复用已有 Caddy 的 80/443 入口，新增独立站点；先备份并验证 Caddy 配置，再 reload，不要覆盖酒馆配置。若酒馆已有 Basic Auth，不要把它直接套在转发器上：它会与转发器的 Bearer 口令冲突，也会影响 CORS 预检。

```caddy
relay.example.com {
  reverse_proxy 127.0.0.1:8787 {
    flush_interval -1
  }
}
```

上例假设 Caddy 在宿主机网络运行。如果 Caddy 是独立桥接网络的容器，应通过容器网络连接转发器，不能把容器内的 `127.0.0.1` 当成宿主机。

nginx 要设置 `proxy_buffering off; proxy_read_timeout 1000s;`。没有域名可使用已有稳定隧道或支持此公网 IP 的域名服务；临时隧道重启后地址可能变化，地址变动后旧任务不能在新地址自动恢复。请勿使用自签证书作为手机正式入口。

## 不用 Docker

使用 Node 18+，建议仍受支持的版本。直接运行：

```sh
RELAY_TOKEN='你生成的至少32位随机口令' node server/relay.mjs
```

可用随附 `moyu-relay.service` 配置 systemd。示例假定代码在 `/opt/moyu`，Node 在 `/usr/bin/node`，并已建立专用低权限用户 `moyu-relay`。请根据实际路径修改。将口令放入 `/etc/moyu-relay.env`（`RELAY_TOKEN=...`，权限 600，root 所有），复制服务文件到 `/etc/systemd/system/`，再执行：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now moyu-relay
```

默认 `HOST=127.0.0.1`、`PORT=8787`。可通过环境变量修改，但不要直接将无 TLS 的服务暴露到公网。

## 在墨游中启用

1. 设置 → 服务器转发：填写 HTTPS 地址、口令及服务器地区，测试并保存，打开总开关。
2. 编辑需要转发的连接，打开“经服务器转发”。没有开启的连接仍直连。
3. 正文开始后自动保存任务编号。刷新、重新打开故事或回到前台，会从同一任务重新读完整返回，不会重新请求模型。续写会保留此前正文作为起点。
4. 主动点“停止”会取消上游请求；页面离开或重连只断开订阅，不取消服务器任务。服务器暂时连不上时，可手动“接回后台生成”，或“停止后台生成”。

连接测试和模型列表仍直连；转发连通性用转发设置里的“测试”检查。Vertex 服务账号仍在设备上换取访问令牌，转发服务只接收这次请求使用的访问令牌，不接收服务账号私钥。正文恢复不重新换令牌。

转发口令及临时任务信息不进入备份。转发服务本身看得到请求内容和本次 API 凭证，但不写入文件或日志；日志仅包含任务编号、上游域名、HTTP 状态、返回字节数和耗时。

## 限制与安全

- 同时最多保留 20 个任务。满额时，新的合法请求可替换最早结束且没有客户端正在读取的任务；正在生成或正在读取的任务都会保留，无法腾出名额才返回 503。
- 每个请求最多 2 MB，每个返回最多 5 MB，每个生成最多 15 分钟。生成失败或主动停止的任务也适用相同缓存规则。
- 仅接受 HTTPS 上游和模型所需的请求头。拒绝本机、内网、链路本地、保留 IPv4/IPv6；检查所有 DNS 结果，并将实际连接固定到已检查的公网 IP，保持 TLS 域名验证。拒绝上游重定向，避免绕过检查或泄漏凭证。
- 流本身总返回 HTTP 200，上游状态及类型通过 `X-Upstream-Status`、`X-Upstream-Content-Type` 传递。模型错误原文保留。客户端在流结束时再查任务状态，防止把异常结束当成完整回复。
- 同一转发口令的持有者可以读取其全部任务，适合个人或相互信任的小范围使用。不要公开口令。
- 推送通知、云备份及其他页面的刷新恢复属于方案第 4 节后续功能，本次未加入。

## 更新与验证

更新会清空当前内存任务，先等生成完成并在手机取回。

```sh
git pull --ff-only
cd server
docker compose up -d --force-recreate
```

如果已经在 `server` 目录，省略 `cd server`。systemd 部署更新后执行 `sudo systemctl restart moyu-relay`。

在仓库根目录运行自动测试（不调用真实模型）：

```sh
node --test tests/*.test.mjs
```

上线后仍需在 iPhone 实测正常正文、切走半分钟、关掉网页再开、主动停止、服务器停机及导出备份。自动测试覆盖鉴权、CORS、SSRF、字节重放、订阅断开、取消、上游错误、容量、过期、客户端解析与备份。浏览器恢复验收页见 `tests/browser-recovery.html`，需用本机 HTTP 服务打开。

## 个人版跑团云端备份

备份服务独立监听 `127.0.0.1:8788`，不需要改现有 API 转发服务。使用 Python 3.9+ 标准库和 SQLite。

1. 在 Ubuntu 建立系统用户 `moyu-backup`（无需登录权限），把 `cloud-backup.py` 放到 `/opt/moyu/server/`。
2. 创建仅 root 可读的 `/etc/moyu-backup.env`。设置 `MOYU_BACKUP_TOKEN` 为随机口令（可用 `openssl rand -hex 32` 生成）。`MOYU_BACKUP_ORIGINS` 默认是 `https://yl2c.github.io`，自定义域名时填网页来源，多个来源以空格分隔并加引号。
3. 将 `moyu-backup.service` 放到 `/etc/systemd/system/`，执行 `sudo systemctl daemon-reload` 和 `sudo systemctl enable --now moyu-backup`。将 `moyu-backup.cron` 以 root:root、0644 安装到 `/etc/cron.d/moyu-backup`。快照在服务器时间 03:00 生成，保留最近 30 份。
4. 在现有 HTTPS 站点转发 `/cloud-backup/`，保留原路径。Nginx 示例：

   ```nginx
   location /cloud-backup/ {
       client_max_body_size 64m;
       proxy_pass http://127.0.0.1:8788;
   }
   ```

5. 打开墨游个人版「设置 → 备份」，填 HTTPS 站点地址和备份口令，打开总开关。第一次会补传现有跑团档案和日常聊天记录，后续按改动上传。备份地址和口令单独保存在本机，手动迁移包不会包含它们。

单个故事可以从「云端存档与回收站」恢复到空缺的本机存档，或下载 JSON。误改时可以解开 `/var/lib/moyu-backup/snapshots/` 中的快照，使用 `cloud-backup.py --db 解压后的副本.sqlite3 export-story 设备ID 故事ID` 导出指定故事，然后在墨游导入 JSON。可从快照的 `records` 表查找完整设备 ID 和故事 ID。同一台服务器上的快照共享磁盘故障风险。

跑团和日常聊天共用备份地址、口令、队列和每日快照。聊天记录可从「聊天备份与恢复」单独下载或恢复。聊天 JSON 仅包含对话和回复版本。若要从历史快照恢复聊天，解压快照副本并执行 `cloud-backup.py --db 解压后的副本.sqlite3 export-chat 设备ID`，再从「导入聊天备份」导入 JSON。服务器若仍使用 .41 的脚本，先更新脚本并重启备份服务。

## 加密全量备份（个人版 .43）

覆盖已保存的故事与讨论、日常聊天、资料全文和编辑版本、聊天记忆、规则、预设、用量、自定义字体和界面偏好。云端只收密文与版本、时间、分块等存储元数据。API 密钥和转发口令继续留在本机。备份服务器口令仍用于连接。

已有 .42 服务器只需替换 /opt/moyu/server/cloud-backup.py 并重启 moyu-backup 服务。SQLite 旧库和 Caddy 路由沿用。更新前可先保留旧脚本，更新后通过带鉴权的 GET /cloud-backup/v1/vault 确认新增接口。前端 .43 可先连接旧服务，启用加密时需要新版服务。

墨游「设置 → 备份 → 加密备份与恢复」设置至少 16 个字符的密码，并可记住此设备。提醒：一般改密码只重新保护数据密钥，假如旧密码和旧密钥副本都曾泄露，要换整把数据密钥才能阻止旧副本参与解密。记住设备可用「锁定此设备」撤销。

首个云端密钥建立后，服务器暂停接收旧版的明文上传。完成本机加密备份后，可在同一页面选择「加密归档旧云端备份」，包括旧库的回收站和快照目录里的历史版本。先在没有旧本机数据的设备或浏览器入口上验证恢复，再决定如何处理旧明文数据库和快照。这个版本不自动删除明文。备份涵盖已写入墨游的内容。恢复前请先确认选的是正确的设备与版本。
