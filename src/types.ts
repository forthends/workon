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
