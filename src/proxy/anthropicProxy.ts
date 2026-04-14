import * as http from 'http';
import * as https from 'https';
import { appendSessionOutput } from '../api/backendClient';

const ANTHROPIC_HOST = 'api.anthropic.com';
const CHUNK_MAX_CHARS = 14_000;

/**
 * Parses Anthropic SSE chunks and returns the assistant text + stop reason.
 */
function parseSSE(sseChunk: string): { text: string; stopReason: string | null } {
  let text = '';
  let stopReason: string | null = null;

  for (const line of sseChunk.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const event = JSON.parse(raw) as Record<string, unknown>;

      if (
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' && event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'text_delta'
      ) {
        text += (event.delta as Record<string, unknown>).text as string;
      }

      if (
        event.type === 'message_delta' &&
        typeof event.delta === 'object' && event.delta !== null
      ) {
        stopReason = ((event.delta as Record<string, unknown>).stop_reason as string) ?? null;
      }
    } catch { /* malformed JSON — skip */ }
  }

  return { text, stopReason };
}

/**
 * Claude Code instructs Claude to append JSON metadata and <system-reminder> blocks
 * after its visible response. Strip everything from the first such block onward.
 */
function stripInternalMetadata(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  // If the entire response is valid JSON, it's pure metadata — discard it
  try { JSON.parse(trimmed); return ''; } catch { /* not pure JSON, continue */ }

  // Truncate at the first {"  (JSON blob with string key) embedded in the text
  const jsonIdx = trimmed.search(/\{"/);
  if (jsonIdx !== -1) {
    const before = trimmed.slice(0, jsonIdx).trim();
    if (before) return before;
    return ''; // JSON was at the very start
  }

  // Truncate at the first <tag (system-reminder etc.)
  const tagIdx = trimmed.search(/<\w/);
  if (tagIdx !== -1) {
    return trimmed.slice(0, tagIdx).trim();
  }

  return trimmed;
}

async function save(sessionId: string, text: string, stream: 'stdout' | 'stderr'): Promise<void> {
  const trimmed = stream === 'stdout' ? stripInternalMetadata(text) : text.trim();
  if (!trimmed) return;
  for (let i = 0; i < trimmed.length; i += CHUNK_MAX_CHARS) {
    await appendSessionOutput(sessionId, trimmed.slice(i, i + CHUNK_MAX_CHARS), stream).catch(() => {});
  }
}

/**
 * Extracts the last user-typed message from the request body.
 * Skips tool results and injected system content (<system-reminder> etc.).
 */
function extractUserMessage(body: Buffer): string | null {
  try {
    const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    const messages = json.messages;
    if (!Array.isArray(messages)) return null;

    // Warmup/init requests have no system prompt and a single message — skip them
    if (!json.system && messages.length === 1) return null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as Record<string, unknown>;
      if (msg.role !== 'user') continue;

      if (typeof msg.content === 'string') {
        const text = msg.content.trim();
        if (!text) continue;
        // Skip plain-string JSON blobs Claude Code injects as metadata
        try { JSON.parse(text); continue; } catch { /* not JSON — it's real user text */ }
        return text;
      }

      if (Array.isArray(msg.content)) {
        const blocks = (msg.content as Array<Record<string, unknown>>)
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => (b.text as string).trim())
          // Drop injected blocks: system tags, JSON blobs, quota notices
          .filter((t) => t.length > 0 && !t.startsWith('<') && !t.startsWith('[') && !t.startsWith('{'));

        // The actual user text is always the last block
        const last = blocks[blocks.length - 1];
        if (last) return last;
        // No valid blocks — keep looking backwards
      }
    }
  } catch { /* not JSON — skip */ }
  return null;
}

export interface ProxyHandle {
  port: number;
  stop: () => Promise<void>;
}

export function startAnthropicProxy(sessionId: string): Promise<ProxyHandle> {
  let lastSavedUserMsg = '';

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const bodyChunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));

      req.on('end', () => {
        const body = Buffer.concat(bodyChunks);

        const userMsg = extractUserMessage(body);
        if (userMsg && userMsg !== lastSavedUserMsg) {
          lastSavedUserMsg = userMsg;
          void save(sessionId, userMsg, 'stderr');
        }

        const headers: Record<string, string | string[] | undefined> = {
          ...req.headers,
          host: ANTHROPIC_HOST,
        };
        // Remove Accept-Encoding so response arrives as plain-text SSE, not gzip
        delete headers['accept-encoding'];

        const proxyReq = https.request(
          { hostname: ANTHROPIC_HOST, port: 443, path: req.url, method: req.method, headers },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);

            let accumulated = '';
            let accStopReason: string | null = null;
            let remainder = '';

            proxyRes.on('data', (chunk: Buffer) => {
              res.write(chunk);

              const raw = remainder + chunk.toString('utf8');
              const lines = raw.split('\n');
              remainder = lines.pop() ?? '';

              const { text, stopReason } = parseSSE(lines.join('\n'));
              accumulated += text;
              if (stopReason) accStopReason = stopReason;
            });

            proxyRes.on('end', () => {
              if (remainder) {
                const { text, stopReason } = parseSSE(remainder);
                accumulated += text;
                if (stopReason) accStopReason = stopReason;
              }
              res.end();

              if (accStopReason === 'end_turn') {
                void save(sessionId, accumulated, 'stdout');
              }
            });

            proxyRes.on('error', () => res.end());
          },
        );

        proxyReq.on('error', () => { res.writeHead(502); res.end(); });
        proxyReq.write(body);
        proxyReq.end();
      });

      req.on('error', () => res.end());
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') { reject(new Error('Failed to bind proxy port')); return; }
      resolve({ port: addr.port, stop: () => new Promise((done) => server.close(() => done())) });
    });

    server.on('error', reject);
  });
}
