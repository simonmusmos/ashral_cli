const BACKEND_URL = 'https://ashral-web.vercel.app';

export interface CreateSessionPayload {
  agent: string;
  name?: string;
}

export async function createSession(payload: CreateSessionPayload): Promise<string> {
  const res = await fetch(`${BACKEND_URL}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as { sessionId: string };
  return data.sessionId;
}

export async function updateSessionStatus(sessionId: string, status: string): Promise<void> {
  await fetch(`${BACKEND_URL}/sessions/${sessionId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  }).catch(() => {}); // best-effort, don't interrupt the session
}

export async function notifySession(
  sessionId: string,
  title: string,
  body: string,
  priority: string,
): Promise<void> {
  await fetch(`${BACKEND_URL}/sessions/${sessionId}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, priority }),
  }).catch(() => {});
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`${BACKEND_URL}/sessions/${sessionId}`, {
    method: 'DELETE',
  }).catch(() => {});
}
