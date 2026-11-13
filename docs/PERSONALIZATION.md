# 墨游个人版与同步

上游：[lishbuwe/moyu](https://github.com/lishbuwe/moyu)。个人仓库：[YL2C/moyu](https://github.com/YL2C/moyu)。

`main` 保留上游原版，`codex/personal` 是日常使用与发布的个人版。GitHub Pages 应部署 `codex/personal` 的根目录。

## 个人习惯

- 输入：括号内写描述、动作、心理或剧情推动，括号外直接写台词；无需引号。游玩页有插入括号按钮。导入旧故事时不改写存档里的原文，发给模型时会附上当前输入约定。
- 选项：A/B/C/D 四项；点击选项会把行动包进括号，仍可修改再发。
- 弹幕：输入框上方随时开关，对当前故事生效并保存。关闭会隐藏已有弹幕，之后生成也不要求弹幕；不删除已经生成的内容。
- 固定姓名与开场示例已换成通用提示。世界设定、角色和规则模块依然按故事配置。
- 本机数据库和当前故事标记使用 `moyu-yl2c-personal` 命名，缓存只管理个人版的条目。旧版故事需先导出备份，再到个人版导入；API 密钥、转发口令需另外填写。
- 新故事默认规则从资料库《世界书 V4.4.4》（2026-11-08）第一至八部分提炼：主动主持、重大选择权、生成性人设、自然节点、选择状态、小说表达、信息边界、连续性与最小纠错。未复制具体人物示例、专题扩展、附录或完整原文；后续修改集中在 `js/personal.js` 的 `PERSONAL_RULES`。已经导入或保存的故事规则不会被自动覆盖。

## 以后怎么同步

给 Codex 的一句话：

> 同步 lishbuwe/moyu 最新功能到 YL2C/moyu 的 codex/personal，保留个人输入、ABCD、弹幕开关、独立存储和个人世界书；先检查本地改动，合并并验证后发布。

执行者先读本文件。不要用整文件覆盖或 `reset --hard` 同步个人分支。`main` 可通过 GitHub 的 Sync fork 更新；这只更新原版镜像，不会更新个人应用。个人应用需要把上游提交合并到 `codex/personal`：

```sh
git switch codex/personal
git status --short
git fetch upstream main
git merge upstream/main
```

如果尚未设置上游，先添加 `upstream`，地址为 `https://github.com/lishbuwe/moyu.git`。遇到冲突保留新功能与个人行为，尤其注意 `js/personal.js` 的调用、`js/prompt.js`、`js/views/play.js`、数据库名及 `sw.js`。发布前更新应用版本和缓存版本，并运行 `node --test tests/*.test.mjs`，在独立的本机 8976 端口验证两个浏览器验收页。最后推送 `codex/personal`，等待 Pages 部署成功。

共同需要的修复可以另开分支贡献给原版；个人文风和世界书留在个人分支或本机配置中。两人的故事、密钥和使用偏好不会随代码合并同步。

## 服务器转发

个人站点来源为 `https://yl2c.github.io`。若使用已有转发器，需要在服务端 `.env` 的 `RELAY_ORIGINS` 加入此来源（保留已有来源），再重启转发服务。口令不可写入仓库。现有服务器是否已允许该来源，应以实际检查结果为准。
