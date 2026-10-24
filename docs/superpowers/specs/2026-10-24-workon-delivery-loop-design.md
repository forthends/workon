# workon 设计规格

| 项 | 值 |
|---|---|
| 文档版本 | 0.1.0 |
| 创建日期 | 2026-10-24 |
| 状态 | 待审阅 |
| 适用 | 一期：产品 Agent 的 PRD 闭环。架构预留二期、三期 |

## 1. 背景与目标

敏捷团队目前用 Cursor、Qoder 等 IDE 协作。PM 用 Qoder 和 PRD 技能生成文档，研发做方案和编码，测试写用例并执行。每个环节都要人发起，简单需求和复杂需求走同一条流程，交付因此变慢。

workon 是一个新项目。它让 AI 接受已经投递的需求并自行交付；阻塞和待确认时通知人审核，完成后通知人验收。人不逐个环节发起任务，只处理审核和验收。

一期证明这件事的最小闭环：常驻进程收到一条需求后，自行调用 PRD 技能，交出产物，并等人接受或退回。

Clockwork、tain-loop、agilehub-loop 只提供可借鉴的做法：确定性状态机、`SKILL.md`、把人工同意当成一次明确的状态迁移。workon 不引用这些项目的代码。

## 2. 已锁定的产品决策

| 决策 | 选择 |
|---|---|
| 项目关系 | 全新项目 workon |
| 需求入口 | 人投递一次原始需求。一期用本机命令，不接 Jira、飞书 |
| 体量分流 | 入口保留 `size` 和 `route`。一期路由器固定走 PRD，不实现跳过 |
| 执行位置 | 一台电脑上的一个常驻进程。本机 HTTP 只绑 `127.0.0.1` |
| 客户端 | 一期同时适配 Qoder 和 Cursor，含发现、选择、失败后换下一个 |
| 选择顺序 | 产品角色固定为 Qoder，然后 Cursor。只区分在线与离线 |
| 技能 | 一份 `SKILL.md` 归 workon。执行归选中的客户端 |
| 结束条件 | 人接受后需求才关闭。退回带意见，同一条需求重新入队 |
| 待处理 | 信息不足、客户端都不可用、或连续中断达到上限时停住并通知人 |
| 部署形态 | 模块按以后能拆开的边界编写。一期不拆成独立控制面，不引入工作流引擎 |

## 3. 一期范围

一期包含：

- 常驻进程、本机 CLI、SQLite、本地产物目录
- 固定的 PRD 路由
- 产品角色循环，同一时间只跑一条
- Qoder 与 Cursor 两个适配器
- 接受、退回、补充、重试
- 系统通知和收件箱
- 自动测试，以及一份手动冒烟清单

一期不包含：

- 按体量跳过 PRD 或方案
- 研发、测试等第二个角色，以及接受之后的下一步分配
- 真实的 MinIO 或 S3
- Web 工作台
- 外部工单系统
- 把常驻进程安装成 launchd 或 systemd 服务
- 忙碌程度调度
- 向量知识库
- 数字置信度分数。把握不足由技能写成 `blocked`
- 修改或提交业务代码仓库

二期使用一期的分配事件、`size` / `route` 字段和存储接口，加上跳过规则和多角色循环。三期把本机 HTTP 上已经存在的查询做成工作台。这两期的内部设计不在本文展开。

## 4. 架构

PM 的电脑上运行一个 TypeScript 进程。CLI 访问 `127.0.0.1` 上的 HTTP。任务、事件、产物索引和收件箱写在 SQLite。产物文件写在工作区目录，登记时使用对象存储形式的 key 和 URL。

```text
人 → CLI → 127.0.0.1 HTTP → 交付循环
                              │ 任务事件
                              ▼
                         产品角色循环
                              │
                         客户端选择
                         qoder -p / agent -p
                              │
                    SQLite · 本地产物目录 · 通知
```

交付循环管理需求状态。产品角色循环只在收到 PRD 分配后执行，并通过执行报告交回结果。角色循环不直接修改交付状态。

进程内用互斥保证同一时间只有一条 PRD 在执行。队列在这些时刻被唤醒：进程启动并完成恢复之后、投递、退回、补充、重试、一轮执行结束。唤醒是进程内信号，不靠定时轮询发现新任务。

状态变更使用 SQLite 事务，并检查期望状态。先把产物文件写到目录，再在同一事务中写入尝试结果、产物索引、需求状态和收件箱。事务提交后再发系统通知。

## 5. 技术选型

| 项 | 选择 |
|---|---|
| 语言与运行时 | TypeScript，Node.js 22 |
| 包 | 一期一个包。测试用 Vitest |
| 数据库 | Node.js 内置 `node:sqlite` 的 `DatabaseSync`。同步事务用于期望状态更新 |
| HTTP | Node.js 内置 `node:http`，只监听 `127.0.0.1` |
| 默认端口 | `4787`，写在工作区配置里。端口已被占用时启动失败 |
| 客户端 | 本机命令 `qoder` 与 `agent`。命令名可在配置中修改，优先级不可配置 |
| 通知 | 收件箱表 + `osascript` 系统通知 |
| 产物 | 接口为 `put(key, body) → { key, url }`。一期 URL 是该文件的 `file://` 绝对地址 |

工作区由 `workon init` 在当前目录创建 `.workon/`：

```text
.workon/
  config.json
  workon.sqlite
  knowledge/              可为空。*.md 会在每轮尝试时被复制
  skills/workon-prd/SKILL.md
  runs/{requirementId}/{n}/
  artifacts/requirements/{id}/attempts/{n}/prd.md
```

`config.json`：

```json
{
  "port": 4787,
  "clients": {
    "qoder": "qoder",
    "cursor": "agent"
  }
}
```

仓库内的 `skills/workon-prd/SKILL.md` 是 init 复制到工作区的模板。运行中的进程读取工作区里的那一份。

建议的源码边界与第 6 节的模块对应，实施计划可以调整文件名，不能合并这些职责：

```text
src/cli.ts
src/daemon.ts
src/http.ts
src/delivery.ts
src/router.ts
src/product-role.ts
src/workspace.ts
src/context.ts
src/knowledge.ts
src/skills.ts
src/skill-mount.ts
src/clients.ts
src/adapters/qoder.ts
src/adapters/cursor.ts
src/artifacts.ts
src/store.ts
src/notify.ts
src/clock.ts
```

时间通过 `Clock` 读取。集成测试注入可控时钟，15 分钟超时不真实等待。

## 6. 模块

| 模块 | 职责 | 对外能力 | 依赖 |
|---|---|---|---|
| CLI | 投递、接受、退回、补充、重试、状态、收件箱、客户端 | 一组子命令 | HTTP API |
| HTTP API | 把命令转成用例调用 | 与子命令对应的路由 | 交付循环、查询 |
| 交付循环 | 需求状态机 | `submit`、`onReport`、`accept`、`reject`、`supplement`、`retry` | 任务库、路由器、通知 |
| 路由器 | 一期固定分配 PRD | `route(requirement) → Assignment` | 无 |
| 产品角色循环 | 领一条分配并完成一轮 | `handle(assignment) → ExecutionReport` | 执行模块、任务库 |
| 任务工作区 | 为每次尝试建目录 | `create(runId) → directory` | 文件系统 |
| 上下文包 | 写 `TASK.md`，复制知识库 | `build(...) → Context` | 知识库 |
| 知识库 | 读取工作区 Markdown | `list`、`read` | 文件系统 |
| 技能目录 | 提供唯一技能包 | `get("workon-prd") → SkillBundle` | `.workon/skills/` |
| 技能挂载 | 把技能复制到客户端路径 | `mount(workspace, adapter, skill)` | 文件系统 |
| 客户端选择 | 发现、按优先级执行、失败则换下一个 | `runWithFallback` | 适配器 |
| 客户端适配器 | 包住一个 CLI | `discover`、`mountPath`、`run` | 子进程 |
| 产物库 | 保存文件并登记 | `put(key, body) → ArtifactRef` | 本地目录、任务库 |
| 任务库 | 持久化 | 需求、笔记、尝试、产物、事件、收件箱 | SQLite |
| 通知 | 写收件箱并在提交后发系统通知 | `notify(event)` | 任务库、osascript |

### 6.1 Assignment

| 字段 | 一期的值 |
|---|---|
| `requirementId` | 需求 id |
| `route` | `prd` |
| `role` | `product` |
| `skillId` | `workon-prd` |
| `size` | `unclassified` |

### 6.2 ExecutionReport

| 字段 | 含义 |
|---|---|
| `outcome` | `completed`、`blocked` 或 `failed` |
| `reason` | 给人看的原因 |
| `needsHumanClass` | `content`、`clients` 或 `interrupted`。完成时为空 |
| `artifact` | `{ key, url }`。仅 `completed` 时有 |
| `clientId` | 产出结果的客户端。都失败时为空 |
| `attempts` | 每次尝试的客户端、状态和错误 |

交付循环把 `completed` 变成 `awaiting_acceptance`。`blocked` 的类别是 `content`。选择器走完仍失败，或开始时都离线，类别是 `clients`。连续中断达到上限时，类别是 `interrupted`，这条报告由启动恢复写入，不由角色循环写入。

### 6.3 ClientAdapter

| 客户端 | 挂载路径（相对任务目录） | 执行要点 |
|---|---|---|
| Qoder | `.qoder/skills/workon-prd/SKILL.md` | `qoder -p --permission-mode accept_edits -w <任务目录> -o json <提示词>` |
| Cursor | `.cursor/skills/workon-prd/SKILL.md` | `agent -p --force --trust --output-format json --workspace <任务目录> <提示词>` |

提示词包含两句固定信息：执行 `/workon-prd`；若同名技能有多份，只遵循本次挂载文件的绝对路径。接着要求阅读 `TASK.md` 和 `knowledge/`。

在线探测执行「配置中的命令名 + `--version`」。5 秒内退出码为 0 才算在线。找不到命令或超时算离线，不启动正式执行。

子进程使用独立进程组。超时或重启时向该进程组发送 `SIGTERM`，5 秒后仍在则发送 `SIGKILL`。

单次正式执行的上限是 15 分钟。标准输出追加到该次尝试的 `stdout.log`，超过 1 MB 的部分截断。

技能名使用 `workon-prd`，避免与用户主目录中的同名技能混淆。workon 不把技能安装到用户主目录。

## 7. 数据模型

标识前缀为 `req_`、`note_`、`art_`、`evt_`、`inb_`，后各跟 12 位小写十六进制。时间用 ISO 8601 UTC。尝试序号从 1 开始。

### 7.1 requirements

| 字段 | 说明 |
|---|---|
| `id` | 主键 |
| `text` | 原始需求正文 |
| `status` | `queued`、`routing`、`in_progress`、`awaiting_acceptance`、`accepted`、`needs_human` |
| `size` | 一期恒为 `unclassified` |
| `route` | 路由完成前为空，之后为 `prd` |
| `needs_human_class` | 空，或 `content`、`clients`、`interrupted` |
| `accepted_artifact_id` | 接受时写入 |
| `consecutive_interruptions` | 连续中断次数，默认 0 |
| `created_at`、`updated_at` | 创建时间不因重新入队而改变 |

取出下一条任务时，在 `status = queued` 中按 `created_at` 升序取最早的一条。退回后的需求仍按最初投递时间排序。

### 7.2 notes

退回和补充按时间追加。字段：`id`、`requirement_id`、`kind`（`reject` 或 `supplement`）、`body`、`created_at`。

### 7.3 attempts

| 字段 | 说明 |
|---|---|
| `requirement_id`、`n` | 联合主键 |
| `client_id` | `qoder` 或 `cursor`。尚未选择时为空 |
| `status` | `running`、`offline`、`failed`、`timeout`、`completed`、`blocked`、`interrupted` |
| `pid` | 正式执行的子进程号。离线或未启动时为空 |
| `run_dir` | 在线尝试的目录。离线尝试为空 |
| `error` | 短错误 |
| `started_at`、`finished_at` | 时间 |

### 7.4 artifacts

`id`、`requirement_id`、`attempt_n`、`key`、`url`、`created_at`。

key 形如 `requirements/{id}/attempts/{n}/prd.md`。

### 7.5 events

`id`、`requirement_id`、`type`、`payload_json`、`created_at`。

事件类型：`requirement.submitted`、`requirement.routed`、`requirement.run_started`、`attempt.finished`、`requirement.awaiting_acceptance`、`requirement.needs_human`、`requirement.requeued`、`requirement.accepted`。回到 `queued` 时写 `requirement.requeued`。每次尝试结束写一条 `attempt.finished`。进入待验收、待处理或已接受时，写与该状态同名的事件。

### 7.6 inbox

`id`、`requirement_id`、`kind`、`summary`、`created_at`。

`kind` 与摘要：

| 场景 | `kind` | `summary` |
|---|---|---|
| 进入待验收 | `awaiting_acceptance` | `PRD 待验收` |
| 内容不足 | `needs_human` | `report.json` 中的原因；空白时为「需要补充信息」 |
| 客户端都离线，或沿优先级走完仍失败 | `needs_human` | `客户端未能完成，等待 retry` |
| 连续中断达到上限 | `needs_human` | `连续中断，等待 retry` |
| 中断后自动回到队列 | `interrupted_retry` | `已中断，将自动重试` |
| 接受 | `accepted` | `PRD 已接受` |

收件箱是这张表。`workon inbox` 读这张表。它和状态变更在同一事务里，因此不另写收件箱文件。

## 8. 数据流

### 8.1 投递到执行

1. `workon submit` 发送 `POST /requirements`，正文去掉首尾空白后不能为空。
2. 交付循环插入需求，状态为 `queued`，并写 `requirement.submitted`。
3. 角色循环空闲时被唤醒，把该需求的期望状态从 `queued` 改为 `routing`。
4. 路由器写入 Assignment，状态改为 `in_progress`，`route = prd`，写 `requirement.routed` 和 `requirement.run_started`。
5. 已有执行进行时，新需求留在 `queued`。

### 8.2 一轮尝试

选择器按 Qoder、Cursor 各走一次尝试。一次尝试对应一个序号。

1. 离线：插入 `status = offline` 的尝试，`run_dir` 和 `pid` 为空，写 `attempt.finished`，换下一个客户端。
2. 在线：插入 `status = running` 的尝试，并创建 `.workon/runs/{requirementId}/{n}/`。
3. 上下文包写入该目录的 `TASK.md`。`需求` 一节是原始正文；`已有反馈` 一节按时间列出退回和补充，没有反馈时写「无」。递归复制 `.workon/knowledge/` 中的 `.md` 到该目录的 `knowledge/`，保留相对路径。知识库为空时不创建额外文件。
4. 把技能挂到这一客户端的路径上。挂载失败则把尝试更新为 `failed`，写 `attempt.finished`，换下一个客户端。
5. 启动无头命令。`report.json` 写在尝试目录根下，`artifacts/prd.md` 写在尝试目录内。

判定以该尝试目录中的文件为准：

| 文件情况 | 尝试状态 | 之后 |
|---|---|---|
| `report.json` 的 `outcome` 为 `completed`，且存在 `artifacts/prd.md` | `completed` | 登记产物，需求进入 `awaiting_acceptance` |
| `outcome` 为 `blocked` | `blocked` | 进入 `needs_human`，类别 `content`。不换客户端 |
| `blocked` 且 `reason` 为空或只有空白 | `blocked` | `reason` 使用「需要补充信息」 |
| `completed` 但没有 PRD 文件 | `failed` | 换下一个客户端 |
| 没有 `report.json`，或 JSON 无法解析，或 `outcome` 不是上述两个值 | `failed` | 换下一个客户端 |
| 进程崩溃、超时、技能文件写失败 | `failed` 或 `timeout` | 换下一个客户端 |

`report.json` 能解析时，以它的 `outcome` 为准，忽略进程退出码。文件缺失或无法解析时，才用退出码和非零结束作为失败。

沿优先级只走一遍。每次尝试结束都写 `attempt.finished`。需求状态在这轮选择结束时才改变：出现 `completed` 或 `blocked` 时立即收口；否则换下一个客户端。都离线或都失败时，需求进入 `needs_human`，类别 `clients`。接受时写入该需求 `attempt_n` 最大的一条产物。

### 8.3 人的动作

| 命令 | 允许条件 | 结果 |
|---|---|---|
| `accept` | `awaiting_acceptance` | `accepted`，写入 `attempt_n` 最大的产物。一期不再分配后续角色 |
| `reject`，意见去空白后非空 | `awaiting_acceptance` | 追加 `reject` 笔记，状态 `queued`，中断计数清零 |
| `supplement`，说明去空白后非空 | `needs_human` 且类别 `content` | 追加 `supplement` 笔记，状态 `queued`，中断计数清零 |
| `retry` | `needs_human` 且类别为 `clients` 或 `interrupted` | 不新增笔记，状态 `queued`，中断计数清零 |

已登记产物保留。新一轮使用更大的尝试序号。下一轮 `TASK.md` 带上全部笔记。

`accepted` 是一期的终态。二期在这个迁移上发出下一角色的分配事件，一期不发。

## 9. 失败与恢复

### 9.1 中断计数

启动时，把状态为 `routing` 或 `in_progress` 的需求都视为中断，并按 `created_at` 升序处理。

1. 若尝试记录了 `pid` 且进程仍在，先按第 6.3 节结束该进程组。
2. `consecutive_interruptions` 加 1。
3. 加完后小于 2：若存在 `status = running` 的尝试，将其标为 `interrupted`。没有尝试记录时只改需求。需求回到 `queued`，收件箱使用第 7.6 节的 `interrupted_retry`。
4. 加完后大于或等于 2：需求进入 `needs_human`，类别 `interrupted`，收件箱使用第 7.6 节对应的 `needs_human` 摘要。

一次尝试正常收口时计数清零。正常收口包括：进入待验收、因内容进入待处理、或客户端路径已经走完并进入待处理。因此第一次中断会自动重试，紧接着的第二次中断停下来等人。`retry`、`reject`、`supplement` 成功时计数清零。

### 9.2 事务与通知

产物文件先落盘。随后一条事务写入尝试、产物索引、需求状态、事件和收件箱，事务内检查期望状态。

通知命令在事务提交之后执行。通知失败不回滚状态。人通过 `workon status` 和 `workon inbox` 看到结果。

事务失败时需求保持原状态。已经写在尝试目录里的文件留在原地。若此时状态仍是 `routing` 或 `in_progress`，下次启动按中断处理。

### 9.3 命令冲突

不符合第 8.3 节时，状态不变，不新增收件箱：

| 情况 | HTTP |
|---|---|
| 正文、意见或补充为空 | 400，`error = invalid` |
| 动作与当前状态或待处理类别不符 | 409，`error = conflict`，响应中带当前 `status` |
| 对已接受的需求再次接受 | 409 |

每次 `submit` 都创建新需求。正文相同的两次投递是两条需求。

内容类待处理只接受 `supplement`。客户端类和中断类待处理只接受 `retry`。

人的退回和补充没有次数上限。

## 10. HTTP 与 CLI

CLI 在当前目录查找 `.workon/config.json`，并使用其中的端口。找不到工作区时失败并说明需要先 `init`。请求和响应为 JSON。进程未启动时，除 `init` 和 `start` 以外的命令失败，并说明常驻进程未启动。`submit` 把子命令之后的全部参数用空格拼成正文。

| 方法与路径 | 成功 |
|---|---|
| `POST /requirements`，`{ "text" }` | 201，`{ id, status: "queued" }` |
| `GET /requirements` | 200，按 `created_at` 升序的需求列表。每项含第 7.1 节的字段，不含笔记和尝试 |
| `GET /requirements/:id` | 200，需求、笔记、尝试、产物 |
| `POST /requirements/:id/accept` | 200，`{ status: "accepted", artifactKey }` |
| `POST /requirements/:id/reject`，`{ "comment" }` | 200，`{ status: "queued" }` |
| `POST /requirements/:id/supplement`，`{ "text" }` | 200，`{ status: "queued" }` |
| `POST /requirements/:id/retry` | 200，`{ status: "queued" }` |
| `GET /inbox` | 200，`{ items: [{ id, requirementId, kind, summary, createdAt }] }` |
| `GET /clients` | 200，`{ clients: [{ id, command, online }] }` |

未知 id 返回 404。

| CLI | 作用 |
|---|---|
| `workon init` | 创建 `.workon/`、配置、模板技能。已存在则失败 |
| `workon start` | 前台运行常驻进程 |
| `workon submit <text>` | 投递 |
| `workon status [id]` | 列表或详情 |
| `workon accept <id>` | 接受 |
| `workon reject <id> <comment>` | 退回 |
| `workon supplement <id> <text>` | 补充 |
| `workon retry <id>` | 把客户端类或中断类待处理放回队列 |
| `workon inbox` | 打印收件箱 |
| `workon clients` | 打印探测结果 |

## 11. 默认技能

init 写入的 `SKILL.md`：

```markdown
---
name: workon-prd
description: 根据 TASK.md 和 knowledge 撰写 PRD。信息不足或没有把握时停止并说明原因。
---

# 撰写 PRD

1. 阅读当前目录的 TASK.md，以及 knowledge/ 下的 Markdown。
2. 信息足够时，把 PRD 写到 artifacts/prd.md。PRD 包含背景、目标、非目标、用户与流程、验收标准。
3. 同时写 report.json：`{"outcome":"completed","reason":""}`。
4. 信息不足，或没有把握继续时，不要猜测。不写 prd.md。写 report.json：`{"outcome":"blocked","reason":"具体缺什么"}`。
5. 只在当前任务目录内创建或修改文件。
```

`name` 与所在目录名 `workon-prd` 一致。

## 12. 测试

自动测试使用假适配器，实现 `discover`、`mountPath` 和 `run`。假 `run` 在任务目录写约定文件，或模拟超时、崩溃和离线。不启动真实的 `qoder` 或 `agent`。

| 行为 | 断言 |
|---|---|
| 路由器 | 任意非空正文得到 `route = prd`、`skillId = workon-prd`、`size = unclassified` |
| 交付状态 | 第 8、9 节的合法迁移；非法动作保持原状态且不新增收件箱 |
| 单飞与队列 | 执行进行中时第二条停在 `queued`；空闲后按 `created_at` 取出 |
| 客户端选择 | 都在线用 Qoder；Qoder 离线或失败用 Cursor；`blocked` 不换客户端；都失败或都离线得到类别 `clients` |
| 技能挂载 | 两个挂载路径的文件内容与工作区技能一致 |
| 结果判定 | 合法 `report.json` 优先于退出码；缺少 PRD、无法解析按第 8.2 节处理；空白 `blocked` 原因变为「需要补充信息」 |
| 产物 | key 符合第 7.4 节；状态提交后通知失败仍然保持待验收 |
| 退回与补充 | 笔记出现在下一轮 `TASK.md`；尝试序号递增；旧产物仍可读取 |
| 重启 | 中断计数 1 时回到 `queued` 且摘要为「已中断，将自动重试」；计数达到 2 时类别为 `interrupted`；存活的 `pid` 会先被结束 |

集成测试启动真实的本机 HTTP 和假适配器，覆盖两条路径：投递后接受；退回后再次进入 `queued`。

手动冒烟在自动测试通过后、本机至少有一个真实 CLI 时做一次：

1. 工作区放入一份短的知识库 Markdown，并保留默认技能。
2. 启动进程，投递一条一两句话的需求。
3. 核对选中的客户端、任务目录中的技能文件、待验收状态和通知。
4. 退回一次，确认下一轮 `TASK.md` 含退回意见。
5. 接受最新产物，确认状态为 `accepted`，且 `file://` 路径能打开 PRD。

两个 CLI 都存在时再做一次：让配置中的 Qoder 命令失效，确认该需求改由 Cursor 执行。这一步只在手动冒烟中做。

## 13. 一期完成标准

- 第 12 节的自动测试通过。
- 第 11 节的技能被 init 写入工作区，挂载内容与它一致。
- 手动冒烟的 5 步在至少一台有一个真实 CLI 的电脑上完成。
- 接受之前，需求不会进入 `accepted`。
- 两个客户端都不可用时，需求进入 `needs_human`，类别为 `clients`，进程不继续启动 CLI。
