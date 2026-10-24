# 快速开始

这篇文档在一个新目录里走完一次 PRD：初始化、启动、投递、退回、再接受。命令和状态的完整说明在 [README.md](README.md)。

## 准备

- Node.js 22 或更新
- 本机 `qoder` 或 `agent` 至少有一个能执行 `--version` 并在 5 秒内返回退出码 0
- 一份 workon 源码。下面用 `WORKON_HOME` 表示仓库所在目录

在要存放工作区的目录里定义入口。当前目录就是工作区，不要在源码仓库里执行，除非你打算把 `.workon/` 放进仓库目录。

```bash
export WORKON_HOME=/path/to/workon

workon() {
  node --experimental-strip-types --experimental-transform-types \
    --import "$WORKON_HOME/scripts/register-ts.mjs" \
    "$WORKON_HOME/src/cli.ts" "$@"
}
```

Node 会打印 Type Stripping 和 SQLite 的实验特性警告。命令本身仍然继续执行。

如果工作区就放在源码仓库里，安装依赖后也可以直接用：

```bash
cd "$WORKON_HOME"
pnpm install
pnpm workon init
```

## 初始化

```bash
mkdir -p ~/workon-demo
cd ~/workon-demo
workon init
```

成功后当前目录出现 `.workon/`，其中有 `config.json`、空的 `knowledge/`、模板技能和 `workon.sqlite`。再执行一次 `init` 会失败，标准错误是「工作区已存在」。

可以把背景写进知识库。只有 `.md` 会在每一轮被复制到任务目录：

```bash
cat > .workon/knowledge/export.md << 'EOF'
# 导出

管理员可以导出当前报表。导出字段至少包括时间和操作者。
EOF
```

需要改端口或客户端命令名时，编辑 `.workon/config.json`。改完后重新 `start`。

## 启动

另开一个终端，进入同一个目录，定义同一个 `workon` 函数，然后：

```bash
workon start
```

这个终端会停在前台。`Ctrl+C` 关闭端口。如果当时有一条需求还在 `in_progress`，这次退出不改它的状态；下次 `start` 会先结束仍存活的进程，再决定放回队列还是停下来等人。

端口已经有进程时，启动失败，提示「端口已被占用」。

## 投递

回到第一个终端：

```bash
workon submit 管理员要导出 CSV
```

标准输出是这条需求的 id 和 `queued`。随后常驻进程领取它。用 `status` 看进展：

```bash
workon status
workon status req_xxxxxxxxxxxx
workon inbox
```

两个客户端都不可用时，状态变成 `needs_human`，类别是 `clients`，收件箱摘要是「客户端未能完成，等待 retry」。装好或改好命令名之后：

```bash
workon retry req_xxxxxxxxxxxx
```

执行成功时，状态变成 `awaiting_acceptance`，收件箱摘要是「PRD 待验收」，并出现一条标题为 workon 的系统通知。PRD 文件在 `accept` 返回的 `artifactKey` 对应的 `file://` 路径上，也在 `.workon/artifacts/` 下。

## 退回后再接受

```bash
workon reject req_xxxxxxxxxxxx 补上导出字段
```

需求回到 `queued`。下一轮任务目录里的 `TASK.md` 含有「退回：补上导出字段」。再次进入待验收后：

```bash
workon accept req_xxxxxxxxxxxx
```

状态变为 `accepted`。对已接受的需求再次接受会失败，提示「当前状态不允许该操作」。

技能认为信息不够时，状态是 `needs_human`，类别是 `content`。这时用补充，而不是 `retry`：

```bash
workon supplement req_xxxxxxxxxxxx 导出字段包括时间和操作者
```

## 确认用的是哪个客户端

```bash
workon clients
```

两个都在线时，这一轮先用 Qoder。要看回退，把 `.workon/config.json` 里的 `clients.qoder` 改成一个不存在的命令名，例如 `workon-missing-qoder`，重启 `start`，再 `submit` 一条新需求。`status <id>` 里 Qoder 那次尝试的状态是 `offline`，随后由 Cursor 执行。

## 常见提示

| 提示 | 原因 |
|---|---|
| 需要先 init | 当前目录没有 `.workon/config.json` |
| 常驻进程未启动 | `start` 没在运行，或端口不对 |
| 正文不能为空 | `submit`、`reject` 或 `supplement` 缺少有效文字 |
| 参数不足 | 少了 id 或意见 |
| 需求不存在 | id 不在这个工作区 |
| 当前状态不允许该操作 | 这个动作和当前状态或待处理类别不匹配 |
| 端口已被占用 | 配置里的端口已有进程 |
| 未知命令 | 子命令不在上面的列表里 |
