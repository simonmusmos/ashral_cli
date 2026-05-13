import { version } from '../../package.json';

const BACKEND_URL = 'https://ashral-web.vercel.app';

export class OutdatedClientError extends Error {
  constructor() {
    super('Your Ashral CLI is outdated. Run `npm install -g ashral` to upgrade.');
    this.name = 'OutdatedClientError';
  }
}

export interface CreateSessionPayload {
  agent: string;
  name: string;
}

export async function createSession(payload: CreateSessionPayload): Promise<string> {
  const res = await fetch(`${BACKEND_URL}/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Ashral-Version': version,
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 426) {
    throw new OutdatedClientError();
  }

  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as { sessionId: string };
  return data.sessionId;
}

export interface PendingAction {
  question?: string;
  options: string[];
}

export async function updateSessionStatus(
  sessionId: string,
  status: string,
  pendingAction?: PendingAction,
): Promise<void> {
  await fetch(`${BACKEND_URL}/sessions/${sessionId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, ...(pendingAction && { pendingAction }) }),
  }).catch(() => {}); // best-effort, don't interrupt the session
}

/** Poll for a response the mobile user submitted. Returns the action string or null. */
export async function getSessionResponse(sessionId: string): Promise<string | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/sessions/${sessionId}/response`);
    if (!res.ok) return null;
    const data = await res.json() as { response: string | null };
    return data.response ?? null;
  } catch {
    return null;
  }
}

export async function notifySession(
  sessionId: string,
  title: string,
  body: string,
  priority: string,
  rawText?: string,
): Promise<void> {
  await fetch(`${BACKEND_URL}/sessions/${sessionId}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, priority, rawText }),
  }).catch(() => {});
}

export async function appendSessionOutput(
  sessionId: string,
  text: string,
  stream: 'stdout' | 'stderr' = 'stdout',
  { throwOnError = false }: { throwOnError?: boolean } = {},
): Promise<void> {
  const req = fetch(`${BACKEND_URL}/sessions/${sessionId}/output`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, stream }),
  });
  if (throwOnError) {
    await req;
  } else {
    await req.catch(() => {});
  }
}

export async function completeSession(sessionId: string, output?: string): Promise<void> {
  try {
    const res = await fetch(`${BACKEND_URL}/sessions/${sessionId}/complete`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ output }),
    });
    if (!res.ok) {
      const body = await res.text();
      process.stderr.write(`[ashral] completeSession failed: ${res.status} ${body}\n`);
    }
  } catch (err) {
    process.stderr.write(`[ashral] completeSession error: ${err}\n`);
  }
}

export async function updateSessionStats(
  sessionId: string,
  delta: { calls?: number; tokens?: number; files?: number; cost?: number },
): Promise<void> {
  await fetch(`${BACKEND_URL}/sessions/${sessionId}/stats`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(delta),
  }).catch(() => {});
}

export async function reactivateSession(sessionId: string): Promise<void> {
  await fetch(`${BACKEND_URL}/sessions/${sessionId}/reactivate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function saveAgentSessionId(sessionId: string, agentSessionId: string): Promise<void> {
  await fetch(`${BACKEND_URL}/sessions/${sessionId}/agent-session`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentSessionId }),
  }).catch(() => {});
}

export interface SessionSummary {
  sessionId: string;
  name: string;
  agent: string;
  status: string;
  agentSessionId?: string;
}

export async function getSession(sessionId: string): Promise<SessionSummary | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/sessions/${sessionId}`);
    if (!res.ok) return null;
    return await res.json() as SessionSummary;
  } catch {
    return null;
  }
}

/** Accepts either a full UUID or an 8-char short ID and returns the full session ID. */
export async function resolveSessionId(input: string): Promise<string | null> {
  if (input.length === 36) return input; // already a full UUID
  try {
    const res = await fetch(`${BACKEND_URL}/sessions/short/${input}`);
    if (!res.ok) return null;
    const data = await res.json() as { sessionId: string };
    return data.sessionId;
  } catch {
    return null;
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`${BACKEND_URL}/sessions/${sessionId}`, {
    method: 'DELETE',
  }).catch(() => {});
}

export interface FileDiffPayload {
  toolUseId: string;
  path: string;
  type: 'str_replace' | 'write_file' | 'create_file';
  oldStr?: string;
  newStr: string;
}

export async function appendSessionDiff(
  sessionId: string,
  diff: FileDiffPayload,
): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/sessions/${sessionId}/diffs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(diff),
  }).catch((err: unknown) => { throw new Error(`network: ${err}`); });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
}
