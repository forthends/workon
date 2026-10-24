import { DatabaseSync } from 'node:sqlite';
import { WorkonError } from './errors.js';
import type { Ids } from './ids.js';
import type {
  Artifact,
  Attempt,
  AttemptStatus,
  ClientId,
  DomainEvent,
  InboxItem,
  NeedsHumanClass,
  Note,
  Requirement,
  RequirementStatus,
} from './types.js';

const SCHEMA = `
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
`;

export interface Store {
  transaction<T>(fn: () => T): T;
  insertRequirement(input: { text: string; now: string }): Requirement;
  getRequirement(id: string): Requirement | undefined;
  listRequirements(): Requirement[];
  oldestQueued(): Requirement | undefined;
  listByStatuses(statuses: RequirementStatus[]): Requirement[];
  updateRequirement(
    id: string,
    expected: RequirementStatus,
    patch: Partial<
      Pick<Requirement, 'status' | 'route' | 'needsHumanClass' | 'acceptedArtifactId' | 'consecutiveInterruptions'>
    > & { updatedAt: string },
  ): void;
  insertNote(input: { requirementId: string; kind: 'reject' | 'supplement'; body: string; now: string }): Note;
  listNotes(requirementId: string): Note[];
  nextAttemptN(requirementId: string): number;
  insertAttempt(attempt: Attempt): void;
  updateAttempt(
    requirementId: string,
    n: number,
    patch: Partial<Pick<Attempt, 'status' | 'pid' | 'error' | 'finishedAt'>>,
  ): void;
  listAttempts(requirementId: string): Attempt[];
  insertArtifact(input: {
    requirementId: string;
    attemptN: number;
    key: string;
    url: string;
    now: string;
  }): Artifact;
  listArtifacts(requirementId: string): Artifact[];
  latestArtifact(requirementId: string): Artifact | undefined;
  insertEvent(input: { requirementId: string; type: string; payload: unknown; now: string }): void;
  listEvents(requirementId: string): DomainEvent[];
  insertInbox(input: {
    requirementId: string;
    kind: InboxItem['kind'];
    summary: string;
    now: string;
  }): InboxItem;
  listInbox(): InboxItem[];
  close(): void;
}

type RequirementRow = {
  id: string;
  text: string;
  status: string;
  size: string;
  route: string | null;
  needs_human_class: string | null;
  accepted_artifact_id: string | null;
  consecutive_interruptions: number;
  created_at: string;
  updated_at: string;
};

type NoteRow = {
  id: string;
  requirement_id: string;
  kind: string;
  body: string;
  created_at: string;
};

type AttemptRow = {
  requirement_id: string;
  n: number;
  client_id: string | null;
  status: string;
  pid: number | null;
  run_dir: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

type ArtifactRow = {
  id: string;
  requirement_id: string;
  attempt_n: number;
  key: string;
  url: string;
  created_at: string;
};

type EventRow = {
  id: string;
  requirement_id: string;
  type: string;
  payload_json: string;
  created_at: string;
};

type InboxRow = {
  id: string;
  requirement_id: string;
  kind: string;
  summary: string;
  created_at: string;
};

function mapRequirement(row: RequirementRow): Requirement {
  return {
    id: row.id,
    text: row.text,
    status: row.status as RequirementStatus,
    size: 'unclassified',
    route: row.route as Requirement['route'],
    needsHumanClass: row.needs_human_class as NeedsHumanClass | null,
    acceptedArtifactId: row.accepted_artifact_id,
    consecutiveInterruptions: row.consecutive_interruptions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNote(row: NoteRow): Note {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    kind: row.kind as Note['kind'],
    body: row.body,
    createdAt: row.created_at,
  };
}

function mapAttempt(row: AttemptRow): Attempt {
  return {
    requirementId: row.requirement_id,
    n: row.n,
    clientId: row.client_id as ClientId | null,
    status: row.status as AttemptStatus,
    pid: row.pid,
    runDir: row.run_dir,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    attemptN: row.attempt_n,
    key: row.key,
    url: row.url,
    createdAt: row.created_at,
  };
}

function mapEvent(row: EventRow): DomainEvent {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at,
  };
}

function mapInbox(row: InboxRow): InboxItem {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    kind: row.kind as InboxItem['kind'],
    summary: row.summary,
    createdAt: row.created_at,
  };
}

export function openStore(dbPath: string, ids: Ids): Store {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  let txDepth = 0;

  function transaction<T>(fn: () => T): T {
    if (txDepth > 0) {
      return fn();
    }
    txDepth++;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      txDepth--;
    }
  }

  function getRequirementRow(id: string): RequirementRow | undefined {
    return db.prepare('SELECT * FROM requirements WHERE id = ?').get(id) as RequirementRow | undefined;
  }

  return {
    transaction,

    insertRequirement(input) {
      const id = ids.next('req');
      db.prepare(
        `INSERT INTO requirements (
          id, text, status, size, route, needs_human_class, accepted_artifact_id,
          consecutive_interruptions, created_at, updated_at
        ) VALUES (?, ?, 'queued', 'unclassified', NULL, NULL, NULL, 0, ?, ?)`,
      ).run(id, input.text, input.now, input.now);
      return mapRequirement(getRequirementRow(id)!);
    },

    getRequirement(id) {
      const row = getRequirementRow(id);
      return row ? mapRequirement(row) : undefined;
    },

    listRequirements() {
      const rows = db
        .prepare('SELECT * FROM requirements ORDER BY created_at ASC, id ASC')
        .all() as RequirementRow[];
      return rows.map(mapRequirement);
    },

    oldestQueued() {
      const row = db
        .prepare(
          `SELECT * FROM requirements WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`,
        )
        .get() as RequirementRow | undefined;
      return row ? mapRequirement(row) : undefined;
    },

    listByStatuses(statuses) {
      if (statuses.length === 0) {
        return [];
      }
      const placeholders = statuses.map(() => '?').join(', ');
      const rows = db
        .prepare(`SELECT * FROM requirements WHERE status IN (${placeholders}) ORDER BY created_at ASC, id ASC`)
        .all(...statuses) as RequirementRow[];
      return rows.map(mapRequirement);
    },

    updateRequirement(id, expected, patch) {
      const current = getRequirementRow(id);
      if (!current) {
        throw new WorkonError(404, 'not_found', '需求不存在');
      }
      if (current.status !== expected) {
        throw new WorkonError(409, 'conflict', '当前状态不允许该操作', current.status as RequirementStatus);
      }

      const sets: string[] = ['updated_at = ?'];
      const values: unknown[] = [patch.updatedAt];

      if (patch.status !== undefined) {
        sets.push('status = ?');
        values.push(patch.status);
      }
      if (patch.route !== undefined) {
        sets.push('route = ?');
        values.push(patch.route);
      }
      if (patch.needsHumanClass !== undefined) {
        sets.push('needs_human_class = ?');
        values.push(patch.needsHumanClass);
      }
      if (patch.acceptedArtifactId !== undefined) {
        sets.push('accepted_artifact_id = ?');
        values.push(patch.acceptedArtifactId);
      }
      if (patch.consecutiveInterruptions !== undefined) {
        sets.push('consecutive_interruptions = ?');
        values.push(patch.consecutiveInterruptions);
      }

      values.push(id);
      db.prepare(`UPDATE requirements SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    },

    insertNote(input) {
      const id = ids.next('note');
      db.prepare(
        'INSERT INTO notes (id, requirement_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, input.requirementId, input.kind, input.body, input.now);
      const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow;
      return mapNote(row);
    },

    listNotes(requirementId) {
      const rows = db
        .prepare('SELECT * FROM notes WHERE requirement_id = ? ORDER BY created_at ASC, id ASC')
        .all(requirementId) as NoteRow[];
      return rows.map(mapNote);
    },

    nextAttemptN(requirementId) {
      const row = db
        .prepare('SELECT COALESCE(MAX(n), 0) AS max_n FROM attempts WHERE requirement_id = ?')
        .get(requirementId) as { max_n: number };
      return row.max_n + 1;
    },

    insertAttempt(attempt) {
      db.prepare(
        `INSERT INTO attempts (
          requirement_id, n, client_id, status, pid, run_dir, error, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        attempt.requirementId,
        attempt.n,
        attempt.clientId,
        attempt.status,
        attempt.pid,
        attempt.runDir,
        attempt.error,
        attempt.startedAt,
        attempt.finishedAt,
      );
    },

    updateAttempt(requirementId, n, patch) {
      const sets: string[] = [];
      const values: unknown[] = [];

      if (patch.status !== undefined) {
        sets.push('status = ?');
        values.push(patch.status);
      }
      if (patch.pid !== undefined) {
        sets.push('pid = ?');
        values.push(patch.pid);
      }
      if (patch.error !== undefined) {
        sets.push('error = ?');
        values.push(patch.error);
      }
      if (patch.finishedAt !== undefined) {
        sets.push('finished_at = ?');
        values.push(patch.finishedAt);
      }

      if (sets.length === 0) {
        return;
      }

      values.push(requirementId, n);
      db.prepare(`UPDATE attempts SET ${sets.join(', ')} WHERE requirement_id = ? AND n = ?`).run(...values);
    },

    listAttempts(requirementId) {
      const rows = db
        .prepare('SELECT * FROM attempts WHERE requirement_id = ? ORDER BY n ASC')
        .all(requirementId) as AttemptRow[];
      return rows.map(mapAttempt);
    },

    insertArtifact(input) {
      const id = ids.next('art');
      db.prepare(
        'INSERT INTO artifacts (id, requirement_id, attempt_n, key, url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, input.requirementId, input.attemptN, input.key, input.url, input.now);
      const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow;
      return mapArtifact(row);
    },

    listArtifacts(requirementId) {
      const rows = db
        .prepare('SELECT * FROM artifacts WHERE requirement_id = ? ORDER BY attempt_n ASC')
        .all(requirementId) as ArtifactRow[];
      return rows.map(mapArtifact);
    },

    latestArtifact(requirementId) {
      const row = db
        .prepare(
          'SELECT * FROM artifacts WHERE requirement_id = ? ORDER BY attempt_n DESC LIMIT 1',
        )
        .get(requirementId) as ArtifactRow | undefined;
      return row ? mapArtifact(row) : undefined;
    },

    insertEvent(input) {
      const id = ids.next('evt');
      db.prepare(
        'INSERT INTO events (id, requirement_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, input.requirementId, input.type, JSON.stringify(input.payload), input.now);
    },

    listEvents(requirementId) {
      const rows = db
        .prepare('SELECT * FROM events WHERE requirement_id = ? ORDER BY created_at ASC, id ASC')
        .all(requirementId) as EventRow[];
      return rows.map(mapEvent);
    },

    insertInbox(input) {
      const id = ids.next('inb');
      db.prepare(
        'INSERT INTO inbox (id, requirement_id, kind, summary, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, input.requirementId, input.kind, input.summary, input.now);
      const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(id) as InboxRow;
      return mapInbox(row);
    },

    listInbox() {
      const rows = db
        .prepare('SELECT * FROM inbox ORDER BY created_at ASC, id ASC')
        .all() as InboxRow[];
      return rows.map(mapInbox);
    },

    close() {
      db.close();
    },
  };
}
