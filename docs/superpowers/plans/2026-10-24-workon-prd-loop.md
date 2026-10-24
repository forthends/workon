# workon 一期 PRD 闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在一台电脑上跑通常驻进程：人投递一次需求后，产品 Agent 用同一份 PRD 技能驱动 Qoder 或 Cursor，登记产物，并等人接受或退回。

**Architecture:** 一个 TypeScript 进程里放交付状态机和产品角色循环，彼此只通过 `Assignment` 与 `ExecutionReport` 通信。状态、事件和收件箱在 SQLite 的同一事务里提交；Qoder 与 Cursor 由可替换的命令运行器启动。一期不拆控制面，不接外部工单。

**Tech Stack:** TypeScript，Node.js 22，Vitest，`node:sqlite` 的 `DatabaseSync`，`node:http`，pnpm。

## Global Constraints

- 语言与运行时：TypeScript，Node.js 22。一期一个包。测试用 Vitest。
- 数据库：Node.js 内置 `node:sqlite` 的 `DatabaseSync`。状态变更用同步事务并检查期望状态。
- HTTP 只监听 `127.0.0.1`。默认端口 `4787`。端口已被占用时启动失败。CLI 读取 `.workon/config.json` 的端口。
- 客户端命令名默认为 `qoder` 与 `agent`，可在配置中修改。优先级固定为 Qoder，然后 Cursor，不可配置。
- 技能 id 固定为 `workon-prd`。不安装到用户主目录。
- 在线探测是「命令名 + `--version`」，5 秒内退出码为 0 才算在线。
- 单次正式执行上限 15 分钟。超时先向进程组发 `SIGTERM`，5 秒后仍在则发 `SIGKILL`。
- 标准输出超过 1 MB 的部分截断。`report.json` 能解析时以它的 `outcome` 为准。
- 空白的 `blocked` 原因使用「需要补充信息」。
- 收件箱摘要只使用规格第 7.6 节的文案：`PRD 待验收`、`需要补充信息`（或 report 中的原因）、`客户端未能完成，等待 retry`、`连续中断，等待 retry`、`已中断，将自动重试`、`PRD 已接受`。
- 产物 key 为 `requirements/{id}/attempts/{n}/prd.md`。URL 为该文件的 `file://` 绝对地址。
- 标识前缀为 `req_`、`note_`、`art_`、`evt_`、`inb_`，后跟 12 位小写十六进制。时间用 ISO 8601 UTC。尝试序号从 1 开始。
- 同一时间只执行一条 PRD。队列按 `created_at` 升序，相同时按 `id` 升序。
- 一期 `size` 恒为 `unclassified`，`route` 只在开工后为 `prd`。不实现按体量跳过，不实现第二个角色，不接 MinIO、S3、Web、Jira 或飞书，不安装 launchd。
- 源码导入使用 Node16 风格的 `.js` 后缀。

---

## File Structure

| 路径 | 职责 |
|---|---|
| `package.json`、`tsconfig.json`、`vitest.config.ts`、`.gitignore` | 包、类型检查、测试 |
| `skills/workon-prd/SKILL.md` | init 复制到工作区的技能模板 |
| `src/types.ts` | 共享类型 |
| `src/ids.ts` | 标识 |
| `src/clock.ts` | 时钟 |
| `src/constants.ts` | 超时、优先级、输出上限 |
| `src/errors.ts` | `WorkonError` |
| `src/store.ts` | SQLite 持久化，不含业务迁移 |
| `src/router.ts` | 固定 PRD 分配 |
| `src/delivery.ts` | 交付状态机、收件箱、事件 |
| `src/notify.ts` | 事务提交后的系统通知 |
| `src/knowledge.ts` | 复制 Markdown |
| `src/context.ts` | 写 `TASK.md` |
| `src/skills.ts` | 读取并挂载技能 |
| `src/judge.ts` | 根据尝试目录判定结果 |
| `src/artifacts.ts` | 把 PRD 字节写到产物路径 |
| `src/prompt.ts` | 无头提示词 |
| `src/process-runner.ts` | 探测、进程组、超时 |
| `src/adapters.ts` | Qoder 与 Cursor 的参数 |
| `src/selector.ts` | 优先级与回退 |
| `src/product-role.ts` | 把分配交给选择器 |
| `src/recovery.ts` | 启动时处理残留的 `routing` / `in_progress` |
| `src/http.ts` | 本机 JSON API |
| `src/config.ts` | 读写工作区配置 |
| `src/init-workspace.ts` | 创建 `.workon/` |
| `src/cli.ts` | 命令行 |
| `src/daemon.ts` | 单飞循环与唤醒 |
| `tests/helpers.ts` | 临时目录、顺序 id、手动时钟的组装 |

路由与开工在同一事务里从 `queued` 写成 `in_progress`。恢复逻辑仍然接受磁盘上残留的 `routing`。`artifacts.put` 只写文件；产物索引由交付循环在收口事务里插入。选择器对离线、失败和超时立即写上 `attempt.finished`；`completed` 与 `blocked` 的那条 `attempt.finished` 由 `onReport` 写入，避免写两次。

## Task 1: 包骨架、类型、标识与时钟

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/types.ts`
- Create: `src/ids.ts`
- Create: `src/clock.ts`
- Create: `src/constants.ts`
- Create: `src/errors.ts`
- Test: `tests/ids.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `RequirementStatus`、`NeedsHumanClass`、`ClientId`、`AttemptStatus`、`Requirement`、`Note`、`Attempt`、`Artifact`、`InboxItem`、`DomainEvent`、`Assignment`、`ArtifactRef`、`ExecutionReport`、`RequirementDetail`
  - `Ids.next(prefix: 'req' | 'note' | 'art' | 'evt' | 'inb'): string`
  - `createIds(): Ids`、`sequentialIds(): Ids`
  - `Clock.now(): Date`、`systemClock`、`manualClock(startIso?: string): Clock & { advance(ms: number): void }`
  - `RUN_TIMEOUT_MS = 900000`、`PROBE_TIMEOUT_MS = 5000`、`KILL_GRACE_MS = 5000`、`STDOUT_LIMIT = 1048576`、`CLIENT_PRIORITY = ['qoder', 'cursor']`
  - `WorkonError(statusCode, error: 'invalid' | 'conflict' | 'not_found', message, requirementStatus?)`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import { createIds, sequentialIds } from '../src/ids.js';
import { manualClock } from '../src/clock.js';
import { CLIENT_PRIORITY, RUN_TIMEOUT_MS } from '../src/constants.js';

describe('ids and clock', () => {
  it('creates a random id with the required prefix and length', () => {
    const id = createIds().next('req');
    expect(id).toMatch(/^req_[0-9a-f]{12}$/);
  });

  it('creates sequential ids for tests', () => {
    const ids = sequentialIds();
    expect(ids.next('note')).toBe('note_000000000001');
    expect(ids.next('note')).toBe('note_000000000002');
  });

  it('advances the manual clock', () => {
    const clock = manualClock('2026-10-24T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-10-24T00:00:00.000Z');
    clock.advance(1000);
    expect(clock.now().toISOString()).toBe('2026-10-24T00:00:01.000Z');
  });

  it('locks the client priority and the run timeout', () => {
    expect(CLIENT_PRIORITY).toEqual(['qoder', 'cursor']);
    expect(RUN_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/ids.test.ts`

Expected: FAIL，找不到模块 `../src/ids.js`。若 `pnpm` 尚未安装依赖，先执行 Step 3 的包文件和 `pnpm install`，再重跑，确认失败原因是源码不存在而不是包管理器。

- [ ] **Step 3: Write minimal implementation**

`package.json`

```json
{
  "name": "workon",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "workon": "node --experimental-strip-types src/cli.ts"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"],
    "skipLibCheck": true,
    "verbatimModuleSyntax": false
  },
  "include": ["src"]
}
```

`vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
```

`.gitignore`

```gitignore
node_modules
dist
.workon
```

`src/types.ts`

```typescript
export type RequirementStatus =
  | 'queued'
  | 'routing'
  | 'in_progress'
  | 'awaiting_acceptance'
  | 'accepted'
  | 'needs_human';

export type NeedsHumanClass = 'content' | 'clients' | 'interrupted';
export type ClientId = 'qoder' | 'cursor';
export type AttemptStatus =
  | 'running'
  | 'offline'
  | 'failed'
  | 'timeout'
  | 'completed'
  | 'blocked'
  | 'interrupted';

export interface Requirement {
  id: string;
  text: string;
  status: RequirementStatus;
  size: 'unclassified';
  route: 'prd' | null;
  needsHumanClass: NeedsHumanClass | null;
  acceptedArtifactId: string | null;
  consecutiveInterruptions: number;
  createdAt: string;
  updatedAt: string;
}

export interface Note {
  id: string;
  requirementId: string;
  kind: 'reject' | 'supplement';
  body: string;
  createdAt: string;
}

export interface Attempt {
  requirementId: string;
  n: number;
  clientId: ClientId | null;
  status: AttemptStatus;
  pid: number | null;
  runDir: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface Artifact {
  id: string;
  requirementId: string;
  attemptN: number;
  key: string;
  url: string;
  createdAt: string;
}

export interface InboxItem {
  id: string;
  requirementId: string;
  kind: 'awaiting_acceptance' | 'needs_human' | 'interrupted_retry' | 'accepted';
  summary: string;
  createdAt: string;
}

export interface DomainEvent {
  id: string;
  requirementId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface Assignment {
  requirementId: string;
  route: 'prd';
  role: 'product';
  skillId: 'workon-prd';
  size: 'unclassified';
}

export interface ArtifactRef {
  key: string;
  url: string;
}

export interface ExecutionReport {
  outcome: 'completed' | 'blocked' | 'failed';
  reason?: string;
  needsHumanClass?: NeedsHumanClass | null;
  artifact?: ArtifactRef;
  clientId?: ClientId;
  winningAttempt?: number;
  attempts: Array<{
    n: number;
    clientId: ClientId | null;
    status: AttemptStatus;
    error?: string;
  }>;
}

export interface RequirementDetail extends Requirement {
  notes: Note[];
  attempts: Attempt[];
  artifacts: Artifact[];
}
```

`src/ids.ts`

```typescript
import { randomBytes } from 'node:crypto';

export type IdPrefix = 'req' | 'note' | 'art' | 'evt' | 'inb';
export interface Ids {
  next(prefix: IdPrefix): string;
}

export function createIds(): Ids {
  return {
    next(prefix) {
      return `${prefix}_${randomBytes(6).toString('hex')}`;
    },
  };
}

export function sequentialIds(): Ids {
  const counters: Record<string, number> = {};
  return {
    next(prefix) {
      counters[prefix] = (counters[prefix] ?? 0) + 1;
      return `${prefix}_${counters[prefix].toString(16).padStart(12, '0')}`;
    },
  };
}
```

`src/clock.ts`

```typescript
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function manualClock(startIso = '2026-10-24T00:00:00.000Z'): Clock & { advance(ms: number): void } {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    advance(msDelta: number) {
      ms += msDelta;
    },
  };
}
```

`src/constants.ts`

```typescript
import type { ClientId } from './types.js';

export const RUN_TIMEOUT_MS = 15 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 5_000;
export const KILL_GRACE_MS = 5_000;
export const STDOUT_LIMIT = 1_048_576;
export const CLIENT_PRIORITY: readonly ClientId[] = ['qoder', 'cursor'];
```

`src/errors.ts`

```typescript
import type { RequirementStatus } from './types.js';

export class WorkonError extends Error {
  constructor(
    readonly statusCode: number,
    readonly error: 'invalid' | 'conflict' | 'not_found',
    message: string,
    readonly requirementStatus?: RequirementStatus,
  ) {
    super(message);
  }
}
```

Run `pnpm install` from the repository root.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/ids.test.ts`

Expected: PASS，4 tests.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .gitignore src/types.ts src/ids.ts src/clock.ts src/constants.ts src/errors.ts tests/ids.test.ts
git commit -m "$(cat <<'EOF'
建立一期包骨架和共享类型，后续模块使用同一套标识与时钟。

EOF
)"
```

## Task 2: SQLite 任务库

**Files:**
- Create: `src/store.ts`
- Create: `tests/helpers.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `Ids`、`Requirement`、`Note`、`Attempt`、`Artifact`、`InboxItem`、`DomainEvent`、`RequirementStatus`、`NeedsHumanClass`、`ClientId`、`AttemptStatus`
- Produces: `openStore(dbPath: string, ids: Ids): Store`

`Store` 方法：

- `transaction<T>(fn: () => T): T`。已在事务中时直接执行 `fn`。
- `insertRequirement(input: { text: string; now: string }): Requirement`
- `getRequirement(id: string): Requirement | undefined`
- `listRequirements(): Requirement[]`，`created_at ASC, id ASC`
- `oldestQueued(): Requirement | undefined`
- `listByStatuses(statuses: RequirementStatus[]): Requirement[]`，同样排序
- `updateRequirement(id: string, expected: RequirementStatus, patch: Partial<Pick<Requirement, 'status' | 'route' | 'needsHumanClass' | 'acceptedArtifactId' | 'consecutiveInterruptions'>> & { updatedAt: string }): void`。期望状态不符时抛出 `WorkonError` 409，`message` 为 `当前状态不允许该操作`。
- `insertNote(input: { requirementId: string; kind: 'reject' | 'supplement'; body: string; now: string }): Note`
- `listNotes(requirementId: string): Note[]`，`created_at ASC, id ASC`
- `nextAttemptN(requirementId: string): number`
- `insertAttempt(attempt: Attempt): void`
- `updateAttempt(requirementId: string, n: number, patch: Partial<Pick<Attempt, 'status' | 'pid' | 'error' | 'finishedAt'>>): void`
- `listAttempts(requirementId: string): Attempt[]`，按 `n` 升序
- `insertArtifact(input: { requirementId: string; attemptN: number; key: string; url: string; now: string }): Artifact`
- `listArtifacts(requirementId: string): Artifact[]`，按 `attempt_n` 升序
- `latestArtifact(requirementId: string): Artifact | undefined`
- `insertEvent(input: { requirementId: string; type: string; payload: unknown; now: string }): void`
- `listEvents(requirementId: string): DomainEvent[]`
- `insertInbox(input: { requirementId: string; kind: InboxItem['kind']; summary: string; now: string }): InboxItem`
- `listInbox(): InboxItem[]`
- `close(): void`

- [ ] **Step 1: Write the failing test**

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkonError } from '../src/errors.js';
import { sequentialIds } from '../src/ids.js';
import { openStore } from '../src/store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'workon-store-'));
  dirs.push(dir);
  return openStore(path.join(dir, 'workon.sqlite'), sequentialIds());
}

describe('store', () => {
  it('lists requirements by created time and then id', () => {
    const store = newStore();
    const later = store.insertRequirement({ text: '后', now: '2026-10-24T00:00:02.000Z' });
    const earlier = store.insertRequirement({ text: '先', now: '2026-10-24T00:00:01.000Z' });
    expect(store.listRequirements().map((item) => item.id)).toEqual([earlier.id, later.id]);
    expect(store.oldestQueued()?.id).toBe(earlier.id);
    store.close();
  });

  it('rejects an update from the wrong status and rolls back the transaction', () => {
    const store = newStore();
    const req = store.insertRequirement({ text: '需求', now: '2026-10-24T00:00:01.000Z' });
    expect(() =>
      store.transaction(() => {
        store.insertNote({ requirementId: req.id, kind: 'reject', body: '不行', now: '2026-10-24T00:00:02.000Z' });
        store.updateRequirement(req.id, 'awaiting_acceptance', { status: 'queued', updatedAt: '2026-10-24T00:00:02.000Z' });
      }),
    ).toThrow(WorkonError);
    expect(store.listNotes(req.id)).toEqual([]);
    expect(store.getRequirement(req.id)?.status).toBe('queued');
    store.close();
  });

  it('numbers attempts and returns the latest artifact', () => {
    const store = newStore();
    const req = store.insertRequirement({ text: '需求', now: '2026-10-24T00:00:01.000Z' });
    expect(store.nextAttemptN(req.id)).toBe(1);
    store.insertAttempt({
      requirementId: req.id,
      n: 1,
      clientId: 'qoder',
      status: 'running',
      pid: null,
      runDir: '/tmp/run',
      error: null,
      startedAt: '2026-10-24T00:00:02.000Z',
      finishedAt: null,
    });
    expect(store.nextAttemptN(req.id)).toBe(2);
    store.insertArtifact({
      requirementId: req.id,
      attemptN: 1,
      key: `requirements/${req.id}/attempts/1/prd.md`,
      url: 'file:///tmp/prd.md',
      now: '2026-10-24T00:00:03.000Z',
    });
    expect(store.latestArtifact(req.id)?.attemptN).toBe(1);
    store.close();
  });
});
```

`tests/helpers.ts` 在本任务创建，供后续任务复用：

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { manualClock } from '../src/clock.js';
import { sequentialIds } from '../src/ids.js';
import { openStore, type Store } from '../src/store.js';

export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testStore(): { store: Store; cleanup: () => void; clock: ReturnType<typeof manualClock> } {
  const { dir, cleanup } = tempDir('workon-db-');
  return { store: openStore(path.join(dir, 'workon.sqlite'), sequentialIds()), cleanup, clock: manualClock() };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/store.test.ts`

Expected: FAIL，找不到 `../src/store.js`。

- [ ] **Step 3: Write minimal implementation**

`src/store.ts` 用 `DatabaseSync` 在打开时执行下面的建表语句，并启用 `PRAGMA foreign_keys = ON`。行映射把 `created_at` 转为 `createdAt`，其余 snake_case 列同样转为上面接口里的 camelCase。`transaction` 用 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`，并用深度计数避免嵌套 `BEGIN`。`updateRequirement` 先读取当前行，`status !== expected` 时抛出 `WorkonError(409, 'conflict', '当前状态不允许该操作', current.status)`。未知 id 抛出 `WorkonError(404, 'not_found', '需求不存在')`。

```sql
CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  size TEXT NOT NULL,
  route TEXT,
  needs_human_class TEXT,
  accepted_artifact_id TEXT,
  consecutive_interruptions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  requirement_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  client_id TEXT,
  status TEXT NOT NULL,
  pid INTEGER,
  run_dir TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (requirement_id, n)
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  attempt_n INTEGER NOT NULL,
  key TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

`insertRequirement` 写入 `status = 'queued'`、`size = 'unclassified'`、`route = NULL`、`needs_human_class = NULL`、`accepted_artifact_id = NULL`、`consecutive_interruptions = 0`，`created_at` 与 `updated_at` 都用传入的 `now`。`insertEvent` 把 `payload` 存成 `JSON.stringify`。`listEvents` 用 `JSON.parse` 还原，并 `ORDER BY created_at ASC, id ASC`。`listNotes` 与 `listInbox` 使用同一排序。`latestArtifact` 取 `attempt_n` 最大的一行。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/store.test.ts tests/ids.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/store.ts tests/store.test.ts tests/helpers.ts
git commit -m "$(cat <<'EOF'
把需求、尝试和收件箱放进同一套可回滚的 SQLite 存储。

EOF
)"
```

## Task 3: 路由器与交付状态机

**Files:**
- Create: `src/router.ts`
- Create: `src/delivery.ts`
- Create: `src/notify.ts`
- Test: `tests/router.test.ts`
- Test: `tests/delivery.test.ts`

**Interfaces:**
- Consumes: `Store`、`Clock`、`WorkonError`、`Assignment`、`ExecutionReport`、`Requirement`、`RequirementDetail`
- Produces:
  - `routeRequirement(requirementId: string): Assignment`
  - `createDelivery(deps: { store: Store; clock: Clock; notify(summary: string): void }): Delivery`
  - `createMacNotifier(): { notify(summary: string): void }`
  - `Delivery.submit(text: string): { id: string; status: 'queued' }`
  - `Delivery.claimNext(): Assignment | null`
  - `Delivery.onReport(requirementId: string, report: ExecutionReport): void`
  - `Delivery.accept(id: string): { status: 'accepted'; artifactKey: string }`
  - `Delivery.reject(id: string, comment: string): { status: 'queued' }`
  - `Delivery.supplement(id: string, text: string): { status: 'queued' }`
  - `Delivery.retry(id: string): { status: 'queued' }`
  - `Delivery.get(id: string): RequirementDetail`
  - `Delivery.list(): Requirement[]`

- [ ] **Step 1: Write the failing test**

`tests/router.test.ts`

```typescript
import { describe, expect, it } from 'vitest';
import { routeRequirement } from '../src/router.js';

describe('router', () => {
  it('assigns every requirement to the PRD skill', () => {
    expect(routeRequirement('req_000000000001')).toEqual({
      requirementId: 'req_000000000001',
      route: 'prd',
      role: 'product',
      skillId: 'workon-prd',
      size: 'unclassified',
    });
  });
});
```

`tests/delivery.test.ts`

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import { createDelivery } from '../src/delivery.js';
import { WorkonError } from '../src/errors.js';
import { testStore } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(notify: (summary: string) => void = () => undefined) {
  const ctx = testStore();
  cleanups.push(ctx.cleanup);
  const delivery = createDelivery({ store: ctx.store, clock: ctx.clock, notify });
  return { ...ctx, delivery };
}

function runningAttempt(store: ReturnType<typeof testStore>['store'], requirementId: string) {
  store.insertAttempt({
    requirementId,
    n: 1,
    clientId: 'qoder',
    status: 'running',
    pid: null,
    runDir: '/tmp/run',
    error: null,
    startedAt: '2026-10-24T00:00:03.000Z',
    finishedAt: null,
  });
}

describe('delivery', () => {
  it('rejects a blank submission', () => {
    const { delivery, store } = setup();
    expect(() => delivery.submit('   ')).toThrow(WorkonError);
    try {
      delivery.submit('   ');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 400, error: 'invalid', message: '正文不能为空' });
    }
    expect(store.listRequirements()).toEqual([]);
  });

  it('trims and records a submission', () => {
    const { delivery, store } = setup();
    const created = delivery.submit('  做一个导出  ');
    expect(created.status).toBe('queued');
    expect(store.getRequirement(created.id)?.text).toBe('做一个导出');
    expect(store.listEvents(created.id).map((event) => event.type)).toEqual(['requirement.submitted']);
  });

  it('claims the earliest queued requirement and holds the lock', () => {
    const { delivery, store, clock } = setup();
    const first = delivery.submit('第一');
    clock.advance(1000);
    const second = delivery.submit('第二');
    expect(delivery.claimNext()).toEqual({
      requirementId: first.id,
      route: 'prd',
      role: 'product',
      skillId: 'workon-prd',
      size: 'unclassified',
    });
    expect(store.getRequirement(first.id)?.status).toBe('in_progress');
    expect(store.getRequirement(first.id)?.route).toBe('prd');
    expect(store.listEvents(first.id).map((event) => event.type)).toEqual([
      'requirement.submitted',
      'requirement.routed',
      'requirement.run_started',
    ]);
    expect(delivery.claimNext()).toBeNull();
    expect(store.getRequirement(second.id)?.status).toBe('queued');
  });

  it('keeps awaiting acceptance when notification throws', () => {
    const { delivery, store } = setup(() => {
      throw new Error('notify failed');
    });
    const created = delivery.submit('需求');
    delivery.claimNext();
    runningAttempt(store, created.id);
    delivery.onReport(created.id, {
      outcome: 'completed',
      clientId: 'qoder',
      winningAttempt: 1,
      artifact: { key: `requirements/${created.id}/attempts/1/prd.md`, url: 'file:///tmp/prd.md' },
      attempts: [{ n: 1, clientId: 'qoder', status: 'completed' }],
    });
    const requirement = store.getRequirement(created.id);
    expect(requirement?.status).toBe('awaiting_acceptance');
    expect(requirement?.consecutiveInterruptions).toBe(0);
    expect(store.listInbox().map((item) => item.summary)).toEqual(['PRD 待验收']);
    expect(store.latestArtifact(created.id)?.key).toBe(`requirements/${created.id}/attempts/1/prd.md`);
  });

  it('turns a blank blocked reason into the fixed summary', () => {
    const { delivery, store } = setup();
    const created = delivery.submit('需求');
    delivery.claimNext();
    runningAttempt(store, created.id);
    delivery.onReport(created.id, {
      outcome: 'blocked',
      reason: '   ',
      needsHumanClass: 'content',
      winningAttempt: 1,
      clientId: 'qoder',
      attempts: [{ n: 1, clientId: 'qoder', status: 'blocked' }],
    });
    expect(store.getRequirement(created.id)?.needsHumanClass).toBe('content');
    expect(store.listInbox()[0]?.summary).toBe('需要补充信息');
  });

  it('parks client failure for retry', () => {
    const { delivery, store } = setup();
    const created = delivery.submit('需求');
    delivery.claimNext();
    delivery.onReport(created.id, { outcome: 'failed', needsHumanClass: 'clients', attempts: [] });
    expect(store.getRequirement(created.id)?.needsHumanClass).toBe('clients');
    expect(store.listInbox()[0]?.summary).toBe('客户端未能完成，等待 retry');
  });

  it('accepts once and reports conflict on the second accept', () => {
    const { delivery, store } = setup();
    const created = delivery.submit('需求');
    delivery.claimNext();
    runningAttempt(store, created.id);
    const key = `requirements/${created.id}/attempts/1/prd.md`;
    delivery.onReport(created.id, {
      outcome: 'completed',
      winningAttempt: 1,
      clientId: 'qoder',
      artifact: { key, url: 'file:///tmp/prd.md' },
      attempts: [],
    });
    expect(delivery.accept(created.id)).toEqual({ status: 'accepted', artifactKey: key });
    const before = store.listInbox().length;
    expect(() => delivery.accept(created.id)).toThrow(WorkonError);
    expect(store.listInbox()).toHaveLength(before);
    expect(store.listInbox().at(-1)?.summary).toBe('PRD 已接受');
  });

  it('requeues a rejection with the trimmed note and no inbox row', () => {
    const { delivery, store } = setup();
    const created = delivery.submit('需求');
    delivery.claimNext();
    runningAttempt(store, created.id);
    delivery.onReport(created.id, {
      outcome: 'completed',
      winningAttempt: 1,
      clientId: 'qoder',
      artifact: { key: 'requirements/x/attempts/1/prd.md', url: 'file:///tmp/prd.md' },
      attempts: [],
    });
    const inboxBefore = store.listInbox().length;
    expect(delivery.reject(created.id, '  意见  ')).toEqual({ status: 'queued' });
    expect(store.listNotes(created.id)).toMatchObject([{ kind: 'reject', body: '意见' }]);
    expect(store.getRequirement(created.id)?.consecutiveInterruptions).toBe(0);
    expect(store.listEvents(created.id).at(-1)?.type).toBe('requirement.requeued');
    expect(store.listInbox()).toHaveLength(inboxBefore);
  });

  it('supplements only content blocks and retries only client or interrupt blocks', () => {
    const { delivery, store } = setup();
    const created = delivery.submit('需求');
    delivery.claimNext();
    delivery.onReport(created.id, { outcome: 'failed', needsHumanClass: 'clients', attempts: [] });
    expect(() => delivery.supplement(created.id, '补充')).toThrow(WorkonError);
    try {
      delivery.supplement(created.id, '补充');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409, requirementStatus: 'needs_human' });
    }
    expect(delivery.retry(created.id).status).toBe('queued');
    delivery.claimNext();
    runningAttempt(store, created.id);
    delivery.onReport(created.id, {
      outcome: 'blocked',
      reason: '缺用户',
      needsHumanClass: 'content',
      winningAttempt: 1,
      clientId: 'qoder',
      attempts: [],
    });
    expect(() => delivery.retry(created.id)).toThrow(WorkonError);
    expect(delivery.supplement(created.id, '用户是管理员').status).toBe('queued');
    expect(store.listNotes(created.id).at(-1)).toMatchObject({ kind: 'supplement', body: '用户是管理员' });
  });

  it('returns not found for an unknown id', () => {
    const { delivery } = setup();
    expect(() => delivery.accept('req_missing')).toThrow(WorkonError);
    try {
      delivery.accept('req_missing');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 404, message: '需求不存在' });
    }
  });
});
```

`manualClock` 已从 `testStore()` 返回。`tests/helpers.ts` 的 `testStore` 必须把同一个 `manualClock()` 实例传给调用方，不能在 `createDelivery` 里另造时钟。上面的测试依赖这一点。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/router.test.ts tests/delivery.test.ts`

Expected: FAIL，找不到 `../src/router.js`。

- [ ] **Step 3: Write minimal implementation**

`src/router.ts`

```typescript
import type { Assignment } from './types.js';

export function routeRequirement(requirementId: string): Assignment {
  return {
    requirementId,
    route: 'prd',
    role: 'product',
    skillId: 'workon-prd',
    size: 'unclassified',
  };
}
```

`src/notify.ts` 在事务之外调用。失败被调用方吞掉。

```typescript
import { execFileSync } from 'node:child_process';

export function createMacNotifier(): { notify(summary: string): void } {
  return {
    notify(summary: string) {
      const escaped = summary.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      execFileSync('osascript', ['-e', `display notification "${escaped}" with title "workon"`], { stdio: 'ignore' });
    },
  };
}
```

`src/delivery.ts`

```typescript
import type { Clock } from './clock.js';
import { WorkonError } from './errors.js';
import { routeRequirement } from './router.js';
import type { Store } from './store.js';
import type { Assignment, ExecutionReport, Requirement, RequirementDetail } from './types.js';

export interface Delivery {
  submit(text: string): { id: string; status: 'queued' };
  claimNext(): Assignment | null;
  onReport(requirementId: string, report: ExecutionReport): void;
  accept(id: string): { status: 'accepted'; artifactKey: string };
  reject(id: string, comment: string): { status: 'queued' };
  supplement(id: string, text: string): { status: 'queued' };
  retry(id: string): { status: 'queued' };
  get(id: string): RequirementDetail;
  list(): Requirement[];
}

export function createDelivery(deps: { store: Store; clock: Clock; notify(summary: string): void }): Delivery {
  const { store } = deps;
  const now = () => deps.clock.now().toISOString();
  const safeNotify = (summary: string) => {
    try { deps.notify(summary); } catch { /* 收件箱已提交 */ }
  };
  const requireExisting = (id: string): Requirement => {
    const requirement = store.getRequirement(id);
    if (!requirement) throw new WorkonError(404, 'not_found', '需求不存在');
    return requirement;
  };
  const requeue = (id: string, expected: Requirement['status'], stamp: string, kind: string) => {
    store.updateRequirement(id, expected, { status: 'queued', needsHumanClass: null, consecutiveInterruptions: 0, updatedAt: stamp });
    store.insertEvent({ requirementId: id, type: 'requirement.requeued', payload: { kind }, now: stamp });
  };

  return {
    submit(text) {
      const trimmed = text.trim();
      if (!trimmed) throw new WorkonError(400, 'invalid', '正文不能为空');
      const stamp = now();
      return store.transaction(() => {
        const requirement = store.insertRequirement({ text: trimmed, now: stamp });
        store.insertEvent({ requirementId: requirement.id, type: 'requirement.submitted', payload: {}, now: stamp });
        return { id: requirement.id, status: 'queued' as const };
      });
    },
    claimNext() {
      return store.transaction(() => {
        if (store.listByStatuses(['routing', 'in_progress']).length > 0) return null;
        const next = store.oldestQueued();
        if (!next) return null;
        const stamp = now();
        store.updateRequirement(next.id, 'queued', { status: 'in_progress', route: 'prd', updatedAt: stamp });
        store.insertEvent({ requirementId: next.id, type: 'requirement.routed', payload: { route: 'prd' }, now: stamp });
        store.insertEvent({ requirementId: next.id, type: 'requirement.run_started', payload: {}, now: stamp });
        return routeRequirement(next.id);
      });
    },
    onReport(requirementId, report) {
      const stamp = now();
      let summary = '';
      store.transaction(() => {
        const current = requireExisting(requirementId);
        if (current.status !== 'in_progress') throw new WorkonError(409, 'conflict', '当前状态不允许该操作', current.status);
        if (report.outcome === 'completed' && report.artifact && report.winningAttempt !== undefined) {
          store.updateAttempt(requirementId, report.winningAttempt, { status: 'completed', finishedAt: stamp, error: null });
          store.insertArtifact({ requirementId, attemptN: report.winningAttempt, key: report.artifact.key, url: report.artifact.url, now: stamp });
          store.updateRequirement(requirementId, 'in_progress', { status: 'awaiting_acceptance', needsHumanClass: null, consecutiveInterruptions: 0, updatedAt: stamp });
          summary = 'PRD 待验收';
          store.insertInbox({ requirementId, kind: 'awaiting_acceptance', summary, now: stamp });
          store.insertEvent({ requirementId, type: 'requirement.awaiting_acceptance', payload: { artifactKey: report.artifact.key }, now: stamp });
          store.insertEvent({ requirementId, type: 'attempt.finished', payload: { n: report.winningAttempt, status: 'completed' }, now: stamp });
          return;
        }
        if (report.outcome === 'blocked' && report.winningAttempt !== undefined) {
          const reason = report.reason?.trim() || '需要补充信息';
          store.updateAttempt(requirementId, report.winningAttempt, { status: 'blocked', finishedAt: stamp, error: reason });
          store.updateRequirement(requirementId, 'in_progress', { status: 'needs_human', needsHumanClass: 'content', consecutiveInterruptions: 0, updatedAt: stamp });
          summary = reason;
          store.insertInbox({ requirementId, kind: 'needs_human', summary, now: stamp });
          store.insertEvent({ requirementId, type: 'requirement.needs_human', payload: { needsHumanClass: 'content' }, now: stamp });
          store.insertEvent({ requirementId, type: 'attempt.finished', payload: { n: report.winningAttempt, status: 'blocked' }, now: stamp });
          return;
        }
        summary = '客户端未能完成，等待 retry';
        store.updateRequirement(requirementId, 'in_progress', { status: 'needs_human', needsHumanClass: 'clients', consecutiveInterruptions: 0, updatedAt: stamp });
        store.insertInbox({ requirementId, kind: 'needs_human', summary, now: stamp });
        store.insertEvent({ requirementId, type: 'requirement.needs_human', payload: { needsHumanClass: 'clients' }, now: stamp });
      });
      safeNotify(summary);
    },
    accept(id) {
      const stamp = now();
      const result = store.transaction(() => {
        const current = requireExisting(id);
        if (current.status !== 'awaiting_acceptance') throw new WorkonError(409, 'conflict', '当前状态不允许该操作', current.status);
        const artifact = store.latestArtifact(id);
        if (!artifact) throw new WorkonError(409, 'conflict', '当前状态不允许该操作', current.status);
        store.updateRequirement(id, 'awaiting_acceptance', { status: 'accepted', acceptedArtifactId: artifact.id, updatedAt: stamp });
        store.insertInbox({ requirementId: id, kind: 'accepted', summary: 'PRD 已接受', now: stamp });
        store.insertEvent({ requirementId: id, type: 'requirement.accepted', payload: { artifactKey: artifact.key }, now: stamp });
        return { status: 'accepted' as const, artifactKey: artifact.key };
      });
      safeNotify('PRD 已接受');
      return result;
    },
    reject(id, comment) {
      const body = comment.trim();
      if (!body) throw new WorkonError(400, 'invalid', '正文不能为空');
      const stamp = now();
      return store.transaction(() => {
        const current = requireExisting(id);
        if (current.status !== 'awaiting_acceptance') throw new WorkonError(409, 'conflict', '当前状态不允许该操作', current.status);
        store.insertNote({ requirementId: id, kind: 'reject', body, now: stamp });
        requeue(id, 'awaiting_acceptance', stamp, 'reject');
        return { status: 'queued' as const };
      });
    },
    supplement(id, text) {
      const body = text.trim();
      if (!body) throw new WorkonError(400, 'invalid', '正文不能为空');
      const stamp = now();
      return store.transaction(() => {
        const current = requireExisting(id);
        if (current.status !== 'needs_human' || current.needsHumanClass !== 'content') {
          throw new WorkonError(409, 'conflict', '当前状态不允许该操作', current.status);
        }
        store.insertNote({ requirementId: id, kind: 'supplement', body, now: stamp });
        requeue(id, 'needs_human', stamp, 'supplement');
        return { status: 'queued' as const };
      });
    },
    retry(id) {
      const stamp = now();
      return store.transaction(() => {
        const current = requireExisting(id);
        if (current.status !== 'needs_human' || (current.needsHumanClass !== 'clients' && current.needsHumanClass !== 'interrupted')) {
          throw new WorkonError(409, 'conflict', '当前状态不允许该操作', current.status);
        }
        requeue(id, 'needs_human', stamp, 'retry');
        return { status: 'queued' as const };
      });
    },
    get(id) {
      const requirement = requireExisting(id);
      return { ...requirement, notes: store.listNotes(id), attempts: store.listAttempts(id), artifacts: store.listArtifacts(id) };
    },
    list() { return store.listRequirements(); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/router.test.ts tests/delivery.test.ts tests/store.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/delivery.ts src/notify.ts tests/router.test.ts tests/delivery.test.ts
git commit -m "$(cat <<'EOF'
用交付状态机把投递、验收和待处理收口到同一次事务。

EOF
)"
```

## Task 4: 任务目录、知识库与技能挂载

**Files:**
- Create: `src/knowledge.ts`
- Create: `src/context.ts`
- Create: `src/skills.ts`
- Create: `skills/workon-prd/SKILL.md`
- Test: `tests/context.test.ts`
- Test: `tests/skills.test.ts`

**Interfaces:**
- Consumes: `Note`、`ClientId`
- Produces:
  - `copyKnowledge(fromDir: string, toDir: string): void`
  - `writeTaskMarkdown(taskDir: string, input: { text: string; notes: Note[] }): void`
  - `loadSkill(workspaceRoot: string): { id: 'workon-prd'; absolutePath: string; body: string }`
  - `mountSkill(taskDir: string, clientId: ClientId, body: string): string`，返回挂载后的绝对路径
  - `SKILL_TEMPLATE` 常量，内容与 `skills/workon-prd/SKILL.md` 相同

- [ ] **Step 1: Write the failing test**

`tests/context.test.ts`：在临时目录放入 `knowledge/a.md` 和 `knowledge/nested/b.md`，另放 `knowledge/skip.txt`。`copyKnowledge` 后，目标目录含两个 `.md` 且保留 `nested/b.md`，不含 `skip.txt`。`writeTaskMarkdown` 在没有笔记时，`已有反馈` 一节的内容为 `无`。有一条退回和一条补充时，按时间输出 `- 退回：意见` 与 `- 补充：说明`。

`tests/skills.test.ts`：把模板写入 `{workspace}/skills/workon-prd/SKILL.md` 后，`loadSkill` 的 `id` 为 `workon-prd`。`mountSkill(taskDir, 'qoder', body)` 的返回路径以 `.qoder/skills/workon-prd/SKILL.md` 结尾，且内容等于 `body`。Cursor 的路径以 `.cursor/skills/workon-prd/SKILL.md` 结尾。模板正文包含 `name: workon-prd`。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/context.test.ts tests/skills.test.ts`

Expected: FAIL，找不到模块。

- [ ] **Step 3: Write minimal implementation**

`copyKnowledge` 递归遍历，只复制以 `.md` 结尾的文件，并用 `path.relative` 保留相对路径。源目录不存在时直接返回。

`writeTaskMarkdown` 写入 `{taskDir}/TASK.md`：

```markdown
# 需求

{text}

# 已有反馈

{notes.length === 0 ? '无' : notes.map(note => `- ${note.kind === 'reject' ? '退回' : '补充'}：${note.body}`).join('\n')}
```

`skills/workon-prd/SKILL.md` 与 `SKILL_TEMPLATE` 都是这段原文：

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

`loadSkill` 读取 `{workspaceRoot}/skills/workon-prd/SKILL.md`。文件不含 `name: workon-prd` 时抛出 `Error('技能名与目录不一致')`。`mountSkill` 按客户端选择相对路径，创建父目录后写入 `body`，返回绝对路径。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/context.test.ts tests/skills.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/knowledge.ts src/context.ts src/skills.ts skills/workon-prd/SKILL.md tests/context.test.ts tests/skills.test.ts
git commit -m "$(cat <<'EOF'
把知识和同一份 PRD 技能放进每次尝试的任务目录。

EOF
)"
```

## Task 5: 结果判定与产物文件

**Files:**
- Create: `src/judge.ts`
- Create: `src/artifacts.ts`
- Test: `tests/judge.test.ts`
- Test: `tests/artifacts.test.ts`

**Interfaces:**
- Consumes: `ArtifactRef`
- Produces:
  - `JudgeInput = { exitCode: number | null; timedOut: boolean }`
  - `JudgeResult = { status: 'completed'; prdPath: string } | { status: 'blocked'; reason: string } | { status: 'failed'; error: string } | { status: 'timeout'; error: string }`
  - `judgeAttempt(taskDir: string, exit: JudgeInput): JudgeResult`
  - `createArtifactStore(workspaceRoot: string): { put(requirementId: string, attemptN: number, body: Buffer): ArtifactRef }`

- [ ] **Step 1: Write the failing test**

`tests/judge.test.ts` 的每个 `it` 使用临时任务目录：

- `timedOut: true` 返回 `status: 'timeout'`，`error: '执行超时'`。即使目录里已有合法 `report.json` 也一样。
- `report.json` 为 `{ "outcome": "completed", "reason": "" }` 且存在 `artifacts/prd.md`，`exitCode: 1` 时返回 `completed`。
- `completed` 但没有 PRD 文件时返回 `failed`，`error: '没有 PRD 文件'`。
- `report.json` 不存在且 `exitCode: 2` 时返回 `failed`，`error` 包含 `2`。
- 文件内容 `not-json` 返回 `failed`，`error: 'report.json 无法解析'`。
- `{ "outcome": "blocked", "reason": "  " }` 返回 `blocked`，`reason: '需要补充信息'`。
- `{ "outcome": "other" }` 返回 `failed`，`error: 'outcome 无效'`。

`tests/artifacts.test.ts`：`put('req_000000000001', 2, Buffer.from('# PRD'))` 的 key 为 `requirements/req_000000000001/attempts/2/prd.md`。`url` 以 `file://` 开头。该 URL 对应的文件内容为 `# PRD`。此测试不打开数据库。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/judge.test.ts tests/artifacts.test.ts`

Expected: FAIL，找不到模块。

- [ ] **Step 3: Write minimal implementation**

`src/judge.ts`

```typescript
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface JudgeInput { exitCode: number | null; timedOut: boolean }
export type JudgeResult =
  | { status: 'completed'; prdPath: string }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; error: string }
  | { status: 'timeout'; error: string };

export function judgeAttempt(taskDir: string, exit: JudgeInput): JudgeResult {
  if (exit.timedOut) return { status: 'timeout', error: '执行超时' };
  const reportPath = path.join(taskDir, 'report.json');
  const prdPath = path.join(taskDir, 'artifacts', 'prd.md');
  if (!existsSync(reportPath)) {
    return { status: 'failed', error: exit.exitCode === null ? '没有 report.json' : `退出码 ${exit.exitCode}` };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { return { status: 'failed', error: 'report.json 无法解析' }; }
  if (!parsed || typeof parsed !== 'object') return { status: 'failed', error: 'report.json 无法解析' };
  const outcome = (parsed as { outcome?: unknown }).outcome;
  const reason = (parsed as { reason?: unknown }).reason;
  if (outcome === 'completed') {
    if (!existsSync(prdPath)) return { status: 'failed', error: '没有 PRD 文件' };
    return { status: 'completed', prdPath };
  }
  if (outcome === 'blocked') {
    const text = typeof reason === 'string' ? reason.trim() : '';
    return { status: 'blocked', reason: text || '需要补充信息' };
  }
  return { status: 'failed', error: 'outcome 无效' };
}
```

`src/artifacts.ts`

```typescript
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArtifactRef } from './types.js';

export function createArtifactStore(workspaceRoot: string): { put(requirementId: string, attemptN: number, body: Buffer): ArtifactRef } {
  return {
    put(requirementId, attemptN, body) {
      const key = `requirements/${requirementId}/attempts/${attemptN}/prd.md`;
      const absolute = path.join(workspaceRoot, 'artifacts', key);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, body);
      return { key, url: pathToFileURL(absolute).href };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/judge.test.ts tests/artifacts.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/judge.ts src/artifacts.ts tests/judge.test.ts tests/artifacts.test.ts
git commit -m "$(cat <<'EOF'
以任务目录里的报告文件判定 PRD 是否可以登记。

EOF
)"
```

## Task 6: 命令运行器与两个客户端适配器

**Files:**
- Create: `src/prompt.ts`
- Create: `src/process-runner.ts`
- Create: `src/adapters.ts`
- Test: `tests/adapters.test.ts`
- Test: `tests/process-runner.test.ts`

**Interfaces:**
- Consumes: `ClientId`、`PROBE_TIMEOUT_MS`、`KILL_GRACE_MS`、`STDOUT_LIMIT`、`RUN_TIMEOUT_MS`
- Produces:
  - `buildPrompt(skillPath: string): string`
  - `CommandRunner.probe(command: string, timeoutMs: number): Promise<boolean>`
  - `CommandRunner.run(input: { command: string; args: string[]; cwd: string; timeoutMs: number; onPid: (pid: number) => void }): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string }>`
  - `createProcessRunner(): CommandRunner`
  - `ClientAdapter = { id: ClientId; command: string; discover(): Promise<boolean>; mountRelative(): string; run(input: { taskDir: string; prompt: string; timeoutMs: number; onPid: (pid: number) => void }): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string }> }`
  - `createQoderAdapter(command: string, runner: CommandRunner): ClientAdapter`
  - `createCursorAdapter(command: string, runner: CommandRunner): ClientAdapter`

- [ ] **Step 1: Write the failing test**

`tests/adapters.test.ts` 使用记录参数的假 `CommandRunner`。断言：

- `buildPrompt('/tmp/SKILL.md')` 同时包含 `/workon-prd`、`/tmp/SKILL.md`、`TASK.md` 和 `knowledge/`。
- Qoder 的 `mountRelative()` 为 `.qoder/skills/workon-prd/SKILL.md`。`run` 调用 runner 时参数为 `['-p', '--permission-mode', 'accept_edits', '-w', taskDir, '-o', 'json', prompt]`。
- Cursor 的 `mountRelative()` 为 `.cursor/skills/workon-prd/SKILL.md`。参数为 `['-p', '--force', '--trust', '--output-format', 'json', '--workspace', taskDir, prompt]`。
- `discover` 调用 `probe(command, 5000)`。假 runner 的 probe 返回 `false` 时 `discover` 为 `false`。

`tests/process-runner.test.ts`：

- `probe('node', 5000)` 为 `true`。`probe('workon-missing-bin', 500)` 为 `false`。
- `run` 使用 `node` 和 `['-e', 'setInterval(() => {}, 1000)']`，`timeoutMs: 200`。结果 `timedOut` 为 `true`。进程结束后 `process.kill(pid, 0)` 抛错。
- runner 把超过 `STDOUT_LIMIT` 的 stdout 截成 1_048_576 字节。用 `node -e "process.stdout.write('x'.repeat(1_200_000))"` 断言返回字符串的 `Buffer.byteLength` 为 1048576。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/adapters.test.ts tests/process-runner.test.ts`

Expected: FAIL，找不到模块。

- [ ] **Step 3: Write minimal implementation**

`buildPrompt` 返回四行，依次是 `执行技能 /workon-prd。`、`若同名技能有多份，只遵循这个文件：${skillPath}`、`阅读 TASK.md 和 knowledge/ 目录中的 Markdown。`、`按技能要求把结果写在当前目录。`

`createProcessRunner` 用 `spawn(command, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`。`onPid(child.pid)` 在 pid 存在时调用。超时后 `process.kill(-pid, 'SIGTERM')`，再等 `KILL_GRACE_MS` 后 `SIGKILL`。收集 stdout，按字节截断到 `STDOUT_LIMIT`。`probe` 执行 `[command, '--version']`，在 `timeoutMs` 内退出码为 0 才返回 `true`。

两个 adapter 的 `discover` 调用 `runner.probe(command, PROBE_TIMEOUT_MS)`。`run` 把上面的参数数组传给 `runner.run`，`command` 用构造时传入的命令名。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/adapters.test.ts tests/process-runner.test.ts`

Expected: PASS。超时用例允许在 5 秒内结束。

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts src/process-runner.ts src/adapters.ts tests/adapters.test.ts tests/process-runner.test.ts
git commit -m "$(cat <<'EOF'
用统一的进程运行器包住 Qoder 和 Cursor 的无头参数。

EOF
)"
```

## Task 7: 客户端选择与产品角色循环

**Files:**
- Create: `src/selector.ts`
- Create: `src/product-role.ts`
- Test: `tests/selector.test.ts`
- Test: `tests/product-role.test.ts`

**Interfaces:**
- Consumes: `ClientAdapter`、`Store`、`Clock`、`ExecutionReport`、`Requirement`、`Note`、`judgeAttempt`、`createArtifactStore`、`writeTaskMarkdown`、`copyKnowledge`、`mountSkill`、`buildPrompt`、`RUN_TIMEOUT_MS`
- Produces:
  - `runWithFallback(deps): Promise<ExecutionReport>`
  - `createProductRole(deps): { handle(assignment: Assignment): Promise<ExecutionReport> }`

`runWithFallback` 的 deps 为 `{ adapters: ClientAdapter[]; requirement: Requirement; notes: Note[]; skillBody: string; store: Store; clock: Clock; workspaceRoot: string; artifacts: ReturnType<typeof createArtifactStore> }`。

- [ ] **Step 1: Write the failing test**

用假 adapter。`discover` 与 `run` 由测试注入。假 `run` 在 `taskDir` 写文件。

- 两个都在线，Qoder 的 `run` 写入 `outcome: completed` 和 `artifacts/prd.md`。报告的 `clientId` 为 `qoder`，`outcome` 为 `completed`，Cursor 的 `run` 次数为 0。产物 key 以 `/attempts/1/prd.md` 结尾。尝试 1 在 `onReport` 之前仍可由 store 读到，且状态为 `running`。
- Qoder `discover` 为 `false`，Cursor 写成 `blocked` 且 `reason` 为 `缺边界`。报告 `needsHumanClass` 为 `content`，`reason` 为 `缺边界`。Qoder 尝试状态为 `offline`，并且已有 `attempt.finished` 事件。Cursor 尝试仍为 `running`。
- Qoder `run` 不写 `report.json` 且 `exitCode` 为 1，Cursor 写成 completed。报告 `clientId` 为 `cursor`，尝试序号为 2。
- 两个都离线。报告 `outcome` 为 `failed`，`needsHumanClass` 为 `clients`，`reason` 为 `客户端未能完成，等待 retry`。

`tests/product-role.test.ts`：`createProductRole` 收到一条 Assignment 后调用选择器。工作区里放一份含 `name: workon-prd` 的技能，以及一条退回笔记。假 Qoder 把 `TASK.md` 读到测试变量里。断言正文包含 `- 退回：意见`，并且挂载文件内容等于技能正文。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/selector.test.ts tests/product-role.test.ts`

Expected: FAIL，找不到模块。

- [ ] **Step 3: Write minimal implementation**

`runWithFallback` 按 `deps.adapters` 的数组顺序循环，调用方必须传入 `[qoder, cursor]`。每个客户端取 `nextAttemptN`。离线时插入 `status: 'offline'`、`runDir: null`、`pid: null`、`error: '离线'`、`finishedAt` 为当前时间的尝试，并写 `attempt.finished`，然后 `continue`。在线时创建 `{workspaceRoot}/runs/{id}/{n}`，插入 `running`，写 `TASK.md`，复制 `knowledge`，`mountSkill`。挂载抛错时把尝试更新为 `failed`，写 `attempt.finished`，`continue`。否则 `adapter.run`，把截断后的 stdout 写入 `{taskDir}/stdout.log`，`onPid` 更新 `pid`。`judgeAttempt` 得到 `completed` 时读取 PRD 并 `artifacts.put`，尝试行保持 `running`，返回 `outcome: 'completed'`、`winningAttempt: n`、`clientId: adapter.id` 和 `artifact`。`blocked` 同样保持 `running`，并返回 `winningAttempt: n`、`needsHumanClass: 'content'` 和判定出的 `reason`。`failed` 或 `timeout` 立即把尝试更新为对应状态并写 `attempt.finished`。循环结束返回 `failed` / `clients`，`reason` 为 `客户端未能完成，等待 retry`。

`createProductRole` 读取 requirement 与 notes，`loadSkill(workspaceRoot)`，用 `deps.commands.qoder` 与 `deps.commands.cursor` 构造两个 adapter，再调用 `runWithFallback`。`deps` 还包括 `runner`、`store`、`clock`、`workspaceRoot`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/selector.test.ts tests/product-role.test.ts tests/delivery.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/selector.ts src/product-role.ts tests/selector.test.ts tests/product-role.test.ts
git commit -m "$(cat <<'EOF'
按 Qoder、Cursor 的顺序执行 PRD，失败时只换一次客户端。

EOF
)"
```

## Task 8: 启动恢复

**Files:**
- Create: `src/recovery.ts`
- Test: `tests/recovery.test.ts`

**Interfaces:**
- Consumes: `Store`、`Clock`
- Produces:
  - `ProcessKiller = { isAlive(pid: number): boolean; killGroup(pid: number): Promise<void> }`
  - `recoverInterrupted(deps: { store: Store; clock: Clock; killer: ProcessKiller; notify(summary: string): void }): Promise<void>`

- [ ] **Step 1: Write the failing test**

- 一条 `in_progress` 需求，`consecutiveInterruptions` 为 0，尝试 `running` 且 `pid` 为 42。`isAlive` 返回 `true`。恢复后 `killGroup` 收到 42，状态为 `queued`，计数为 1，收件箱摘要为 `已中断，将自动重试`。
- 同一条需求计数已是 1。恢复后状态为 `needs_human`，类别 `interrupted`，摘要为 `连续中断，等待 retry`，计数为 2。
- `routing` 且没有尝试记录。计数从 0 变为 1，状态为 `queued`。
- `notify` 抛错时，状态仍按上面的规则改变。

直接用 `store.insertRequirement` 后 `updateRequirement` 把状态改成 `in_progress` 或 `routing`，不要经过 `claimNext`，这样可以造出残留的 `routing`。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/recovery.test.ts`

Expected: FAIL，找不到 `../src/recovery.js`。

- [ ] **Step 3: Write minimal implementation**

按 `listByStatuses(['routing', 'in_progress'])` 的顺序处理。对 `status === 'running'` 且 `pid` 非空并且 `isAlive(pid)` 的尝试调用 `killGroup`。计数加 1。小于 2 时把该 `running` 尝试标为 `interrupted`，需求回到 `queued`，`needsHumanClass` 清空，写 `requirement.requeued` 和 `interrupted_retry` 收件箱。大于或等于 2 时需求进入 `needs_human` / `interrupted`，写 `requirement.needs_human` 和对应收件箱。事务提交后再 `notify`。`notify` 的异常吞掉。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/recovery.test.ts tests/delivery.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/recovery.ts tests/recovery.test.ts
git commit -m "$(cat <<'EOF'
启动时把中断的需求自动放回队列，连续两次则停下来等人。

EOF
)"
```

## Task 9: 本机 HTTP

**Files:**
- Create: `src/http.ts`
- Test: `tests/http.test.ts`

**Interfaces:**
- Consumes: `Delivery`、`Store`、`WorkonError`
- Produces: `createHttpServer(deps: { delivery: Delivery; discover(): Promise<Array<{ id: 'qoder' | 'cursor'; command: string; online: boolean }>> }): import('node:http').Server`

服务器由测试 `listen(0, '127.0.0.1')`。请求和响应为 JSON。路由与规格第 10 节一致。`WorkonError` 映射为对应状态码，409 的响应体包含 `error`、`message`、`status`。未知路径返回 404，`message` 为 `路径不存在`。无法解析的 JSON 返回 400，`message` 为 `正文不能为空` 之外的 `JSON 无法解析`。

- [ ] **Step 1: Write the failing test**

用 `createDelivery` 和 `testStore()`。`discover` 返回两个在线客户端。用例：

- `POST /requirements` 正文 `{ "text": " 导出 " }` 返回 201，`status` 为 `queued`。
- `POST /requirements` `{ "text": " " }` 返回 400，`error` 为 `invalid`。
- 把需求推进到待验收后，`POST /requirements/:id/accept` 返回 200 和 `artifactKey`。再次接受返回 409，且 `status` 为 `accepted`。
- 未知 id 返回 404。
- `GET /requirements` 按 `createdAt` 升序，元素不含 `notes`。
- `GET /clients` 返回 `discover` 的结果。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/http.test.ts`

Expected: FAIL，找不到 `../src/http.js`。

- [ ] **Step 3: Write minimal implementation**

用 `node:http`。读取 body 后 `JSON.parse`。用 `pathname` 和 `method` 分发到 `delivery` 的同名方法。`GET /inbox` 返回 `{ items: store 无法从 Delivery 得到 }`。因此 `createHttpServer` 的 deps 增加 `listInbox(): InboxItem[]`，由调用方传入 `store.listInbox`。`GET /requirements/:id` 返回 `delivery.get`。成功的 accept 返回 delivery 的结果。捕获 `WorkonError` 时写出 `statusCode` 和 `{ error, message, status: requirementStatus }`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/http.test.ts tests/delivery.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/http.ts tests/http.test.ts
git commit -m "$(cat <<'EOF'
把交付动作暴露为本机 JSON API，供 CLI 调用。

EOF
)"
```

## Task 10: 初始化工作区与 CLI

**Files:**
- Create: `src/config.ts`
- Create: `src/init-workspace.ts`
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `SKILL_TEMPLATE`、`default` 端口 4787、默认命令名 `qoder` 与 `agent`
- Produces:
  - `loadConfig(workspaceRoot: string): { port: number; clients: { qoder: string; cursor: string } }`
  - `initWorkspace(cwd: string): void`
  - `runCli(argv: string[], io: { cwd: string; stdout: string[]; stderr: string[]; fetch: typeof fetch }): Promise<number>`

- [ ] **Step 1: Write the failing test**

在临时 cwd：

- `runCli(['init'], io)` 创建 `.workon/config.json`，端口 4787，命令名为 `qoder` 和 `agent`。`.workon/skills/workon-prd/SKILL.md` 与 `SKILL_TEMPLATE` 相同。`.workon/workon.sqlite` 存在。再次 init 返回 1，stderr 含 `工作区已存在`。
- 没有 `.workon` 时 `submit` 返回 1，stderr 含 `需要先 init`。
- init 之后，`fetch` 抛 `ECONNREFUSED`。`submit 导出` 返回 1，stderr 含 `常驻进程未启动`。
- `fetch` 对 `POST /requirements` 返回 201 `{ id: 'req_000000000001', status: 'queued' }`。`runCli(['submit', '导出', '报表'], io)` 把 body 里的 `text` 发成 `导出 报表`，stdout 是格式化 JSON，退出码 0。

`src/cli.ts` 在作为入口执行时调用 `runCli(process.argv.slice(2), { cwd: process.cwd(), stdout 写到 console, stderr 写到 console, fetch: globalThis.fetch })`，并 `process.exit(code)`。判断入口用 `import.meta.url` 与 `pathToFileURL(process.argv[1]).href` 比较。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/cli.test.ts`

Expected: FAIL，找不到模块。

- [ ] **Step 3: Write minimal implementation**

`initWorkspace` 在 `.workon` 已存在时抛出 `Error('工作区已存在')`。否则创建 `knowledge/`、写入 `config.json`、用 `SKILL_TEMPLATE` 写技能，并 `openStore` 后立刻 `close`，从而生成空库。`loadConfig` 读取该 JSON。`runCli` 的 `init` 捕获「工作区已存在」。其他命令先找 `.workon/config.json`，没有则 stderr 写 `需要先 init`。`submit` 把 `argv.slice(1)` 用空格拼接。HTTP 失败时 stderr 写 `常驻进程未启动`。非 2xx 时把响应 `message` 写到 stderr 并返回 1。2xx 时 `JSON.stringify(data, null, 2)` 写入 stdout。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/cli.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/init-workspace.ts src/cli.ts tests/cli.test.ts
git commit -m "$(cat <<'EOF'
提供 init 和访问本机 API 的命令，工作区不在时给出明确失败。

EOF
)"
```

## Task 11: 常驻循环与集成测试

**Files:**
- Create: `src/wake.ts`
- Create: `src/daemon.ts`
- Test: `tests/daemon.test.ts`

**Interfaces:**
- Consumes: `Delivery`、`recoverInterrupted`、`createProductRole`、`createHttpServer`、`createWake`
- Produces:
  - `createWake(): { wake(): void; wait(signal: AbortSignal): Promise<void> }`
  - `runDaemon(deps: { delivery: Delivery; role: { handle(assignment: Assignment): Promise<ExecutionReport> }; recover(): Promise<void>; wake: ReturnType<typeof createWake>; signal: AbortSignal }): Promise<void>`

`runDaemon` 先 `await recover()`，再 `wake.wake()`。循环中若未中止，调用 `claimNext`。有分配则 `await role.handle`，再 `onReport`。`handle` 抛错时构造 `{ outcome: 'failed', needsHumanClass: 'clients', reason: error.message, attempts: [] }` 交给 `onReport`，避免需求停在 `in_progress`。没有分配时 `await wake.wait(signal)`。`signal` 已中止时返回。

- [ ] **Step 1: Write the failing test**

`tests/daemon.test.ts` 有两条集成路径，都使用假 adapter，不启动 `qoder` 或 `agent`。

1. 假 Qoder `run` 写入 completed 的 `report.json` 和 `artifacts/prd.md`。启动 HTTP 与 `runDaemon`。`POST /requirements` 后轮询 `GET /requirements/:id`，直到 `awaiting_acceptance`。`POST accept` 后状态为 `accepted`，`artifactKey` 指向的 `file://` 文件存在。
2. 第一次 `run` 写 completed，测试者 `reject`，响应 `status` 为 `queued`。假 `run` 在第二次把读到的 `TASK.md` 存进数组。数组第二项包含退回意见。随后再次等到 `awaiting_acceptance`。

另测单飞：第一个 `run` 在 Promise 上挂起时，第二条需求保持 `queued`。放开第一个 `run` 后，第二条才进入 `in_progress` 或更后的状态。

时钟用 `manualClock`，但 `runDaemon` 不依赖真实的 15 分钟。假 `run` 立即返回。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/daemon.test.ts`

Expected: FAIL，找不到 `../src/daemon.js`。

- [ ] **Step 3: Write minimal implementation**

`createWake` 保存一个布尔值。`wake` 把它设为 true 并 resolve 正在等待的 Promise。`wait` 在布尔值已为 true 时清掉并返回；否则等下一次 `wake` 或 `abort`。

`src/daemon.ts` 导出 `runDaemon`。HTTP 层不放进 `runDaemon`；测试和 `workon start` 各自创建 server。`src/cli.ts` 的 `start` 命令在本任务补上：`init` 已存在时，`loadConfig`，`openStore`，`createDelivery` 的 `notify` 使用 `createMacNotifier`，`recoverInterrupted` 使用真实的进程检查（`process.kill(pid, 0)` 与 `process.kill(-pid, signal)`），`createProductRole` 使用 `createProcessRunner` 和配置里的命令名。`server.listen(config.port, '127.0.0.1')`。`EADDRINUSE` 时 stderr 写 `端口已被占用` 并退出 1。`SIGINT` 时 abort 循环并关闭 server，不在信号里改需求状态。

把 `start` 的端口占用测试放在 `tests/cli.test.ts` 末尾：先占住一个端口，把该端口写进临时工作区的 `config.json`，调用从 `cli.ts` 导出的 `startDaemon(cwd)`，期望拒绝并带有 `端口已被占用`。因此 Step 3 同时导出 `startDaemon(cwd: string, env?: { notify?: typeof createMacNotifier }): Promise<{ close(): Promise<void> }>`，供测试注入不发系统通知的 notify。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`

Expected: PASS，包含此前全部测试。

- [ ] **Step 5: Commit**

```bash
git add src/wake.ts src/daemon.ts src/cli.ts tests/daemon.test.ts tests/cli.test.ts
git commit -m "$(cat <<'EOF'
让常驻进程串行领取需求，并跑通投递、退回和接受。

EOF
)"
```

## Task 12: 手动冒烟

**Files:**
- Modify: 无

本任务不改文件，没有提交。自动测试已经通过后，在至少安装了 `qoder` 或 `agent` 其中一个的电脑上执行。

- [ ] **Step 1: 准备可写的空目录并初始化**

```bash
mkdir -p /tmp/workon-smoke && cd /tmp/workon-smoke
node --experimental-strip-types /Users/tenet/Workspace/Projects/workon/src/cli.ts init
printf '%s\n' '# 导出' '管理员可以导出报表。' > .workon/knowledge/export.md
```

Expected: `.workon/skills/workon-prd/SKILL.md` 存在，且含 `name: workon-prd`。

- [ ] **Step 2: 启动并投递**

另开终端，在同一目录执行 `node --experimental-strip-types <仓库>/src/cli.ts start`。原终端执行：

```bash
node --experimental-strip-types /Users/tenet/Workspace/Projects/workon/src/cli.ts submit 管理员要导出 CSV
```

Expected: 需求进入 `awaiting_acceptance` 或 `needs_human`。若是待验收，`.workon/runs/` 下的技能文件位于所选客户端的挂载路径，收件箱摘要为 `PRD 待验收`，并出现系统通知。

- [ ] **Step 3: 退回后再接受**

```bash
node --experimental-strip-types /Users/tenet/Workspace/Projects/workon/src/cli.ts reject <id> 补上导出字段
```

Expected: 下一次尝试的 `TASK.md` 含 `退回：补上导出字段`。再次进入待验收后：

```bash
node --experimental-strip-types /Users/tenet/Workspace/Projects/workon/src/cli.ts accept <id>
```

Expected: 状态为 `accepted`，`artifactKey` 对应的 `file://` 路径能打开 PRD。

- [ ] **Step 4: 两个 CLI 都存在时验证回退**

把 `.workon/config.json` 的 `clients.qoder` 改成 `workon-missing-qoder`，重启 `start`，再 `submit` 一条新需求。

Expected: 尝试记录里 Qoder 为 `offline`，Cursor 执行并产生结果。这一步不进入自动测试。
