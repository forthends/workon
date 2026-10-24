# workon

workon 在一台电脑上跑一个常驻进程。人用一句话投递需求，产品角色用同一份 PRD 技能驱动本机的 Qoder；Qoder 离线或这次执行失败时，换 Cursor 再试一次。产物登记后等人接受。信息不够、两个客户端都不可用，或连续中断达到上限时，进程停下来通知人。

一期只做这条 PRD 闭环。设计见 [docs/superpowers/specs/2026-10-24-workon-delivery-loop-design.md](docs/superpowers/specs/2026-10-24-workon-delivery-loop-design.md)，实施步骤见 [docs/superpowers/plans/2026-10-24-workon-prd-loop.md](docs/superpowers/plans/2026-10-24-workon-prd-loop.md)。从零跑通一次见 [quickstart.md](quickstart.md)。

## 一期包含

- 本机 CLI，以及只监听 `127.0.0.1` 的 HTTP
- SQLite 里的需求、笔记、尝试、产物索引、事件和收件箱
- 同一时间只执行一条 PRD。队列按投递时间排序
- Qoder 优先，然后 Cursor。命令名可改，顺序不可改
- 接受、退回、补充、重试
- macOS 上用 `osascript` 发系统通知。通知失败不回滚已经提交的状态

一期把每条需求都做成 PRD。`size` 固定为 `unclassified`。不接 Jira、飞书、S3、Web 工作台，也不把进程装成开机服务。接受之后没有下一个角色。

## 环境

- Node.js 22 或更新
- 本机至少有一个客户端：Qoder 的命令是 `qoder`，Cursor 的无头命令是 `agent`
- 跑测试时再安装 pnpm

源码用 `.js` 后缀引用 TypeScript 文件，并且 `WorkonError` 使用了参数属性。直接 `node --experimental-strip-types src/cli.ts` 无法启动。仓库脚本先注册一个说明符钩子，再打开类型转换：

```bash
pnpm workon
```

它等价于：

```bash
node --experimental-strip-types --experimental-transform-types \
  --import ./scripts/register-ts.mjs src/cli.ts
```

在别的目录里做工作区时，把这两条路径换成仓库的绝对路径。当前目录决定 `.workon` 建在哪里。

## 命令

除 `init` 和 `start` 以外，命令都访问已经启动的常驻进程。成功时标准输出是缩进后的 JSON。

| 命令 | 作用 |
|---|---|
| `init` | 在当前目录创建 `.workon/`。目录已存在则失败 |
| `start` | 前台运行常驻进程。`Ctrl+C` 结束循环并关闭端口，不改写进行中的需求 |
| `submit <正文>` | 投递一条新需求。参数用空格拼成正文 |
| `status` | 按创建时间列出需求 |
| `status <id>` | 查看一条需求的笔记、尝试和产物 |
| `accept <id>` | 接受待验收的 PRD |
| `reject <id> <意见>` | 退回待验收的需求，意见进入下一轮 `TASK.md` |
| `supplement <id> <说明>` | 补充内容类待处理，然后重新入队 |
| `retry <id>` | 把客户端类或中断类待处理放回队列 |
| `inbox` | 打印收件箱 |
| `clients` | 探测两个客户端现在是否在线 |

## 人看到的状态

| 状态 | 含义 | 可以做的事 |
|---|---|---|
| `queued` | 在队列里 | 等进程领取 |
| `in_progress` | 正在执行 | 等这一轮结束。进程被打断后，下次 `start` 会把它当中断处理 |
| `awaiting_acceptance` | PRD 已登记 | `accept` 或 `reject` |
| `needs_human` | 停下来等人 | 类别 `content` 用 `supplement`；类别 `clients` 或 `interrupted` 用 `retry` |
| `accepted` | 已接受 | 一期到此结束 |

第一次中断会自动回到队列，收件箱摘要是「已中断，将自动重试」。紧接着的第二次中断停在 `needs_human`，摘要是「连续中断，等待 retry」。

待验收的摘要是「PRD 待验收」。内容不足时摘要是技能写下的原因，空白则是「需要补充信息」。两个客户端都没完成时，摘要是「客户端未能完成，等待 retry」。

## 工作区

`init` 在当前目录创建：

```text
.workon/
  config.json
  workon.sqlite
  knowledge/                          *.md 会复制到每一轮尝试
  skills/workon-prd/SKILL.md          运行时读这一份，不读用户主目录
  runs/{requirementId}/{n}/           任务目录：TASK.md、report.json、stdout.log
  artifacts/requirements/{id}/attempts/{n}/prd.md
```

默认配置：

```json
{
  "port": 4787,
  "clients": {
    "qoder": "qoder",
    "cursor": "agent"
  }
}
```

`clients` 只改本机命令名。在线的判断是「命令名 `--version`」在 5 秒内退出码为 0。单次执行上限 15 分钟。端口被占用时 `start` 失败，并提示「端口已被占用」。

Qoder 把技能挂到任务目录的 `.qoder/skills/workon-prd/SKILL.md`。Cursor 挂到 `.cursor/skills/workon-prd/SKILL.md`。提示词会点名 `/workon-prd` 和这次挂载文件的绝对路径。

## 开发

```bash
pnpm install
pnpm test
```

自动测试使用假的命令运行器，不启动真实的 `qoder` 或 `agent`。测试输出里的 `ExperimentalWarning: SQLite is an experimental feature` 来自 Node 内置的 `node:sqlite`。
