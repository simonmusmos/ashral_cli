import * as http from 'http';
import * as https from 'https';
import { appendSessionOutput, updateSessionStats } from '../api/backendClient';

const ANTHROPIC_HOST = 'api.anthropic.com';
const CHUNK_MAX_CHARS = 14_000;

/**
 * Parses Anthropic SSE chunks and returns text, stop reason, and token usage.
 */
function parseSSE(sseChunk: string): {
  text: string;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
} {
  let text = '';
  let stopReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

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

      if (event.type === 'message_start') {
        const usage = ((event.message as Record<string, unknown>)?.usage ?? {}) as Record<string, number>;
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
      }

      if (
        event.type === 'message_delta' &&
        typeof event.delta === 'object' && event.delta !== null
      ) {
        stopReason = ((event.delta as Record<string, unknown>).stop_reason as string) ?? null;
        const usage = (event.usage ?? {}) as Record<string, number>;
        outputTokens += usage.output_tokens ?? 0;
      }
    } catch { /* malformed JSON — skip */ }
  }

  return { text, stopReason, inputTokens, outputTokens };
}

// Pricing in USD per million tokens (input / output).
// Covers current Claude 4 and Claude 3.x model families.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude 4
  'claude-opus-4':      { input: 15,   output: 75   },
  'claude-sonnet-4':    { input: 3,    output: 15   },
  'claude-haiku-4':     { input: 0.25, output: 1.25 },
  // Claude 3.7 / 3.5 / 3
  'claude-3-7-sonnet':  { input: 3,    output: 15   },
  'claude-3-5-sonnet':  { input: 3,    output: 15   },
  'claude-3-5-haiku':   { input: 0.8,  output: 4    },
  'claude-3-opus':      { input: 15,   output: 75   },
  'claude-3-sonnet':    { input: 3,    output: 15   },
  'claude-3-haiku':     { input: 0.25, output: 1.25 },
};

function modelPricing(model: string): { input: number; output: number } {
  for (const [prefix, price] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(prefix)) return price;
  }
  return { input: 3, output: 15 }; // safe default (Sonnet tier)
}

function extractModel(body: Buffer): string {
  try {
    const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    return typeof json.model === 'string' ? json.model : '';
  } catch { return ''; }
}

/**
 * Extracts unique file paths touched by tool_use calls in assistant messages.
 * The request body contains the full conversation history so we can scan it here.
 */
function extractToolFilePaths(body: Buffer): string[] {
  try {
    const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    const messages = json.messages;
    if (!Array.isArray(messages)) return [];
    const paths: string[] = [];
    for (const msg of messages as Array<Record<string, unknown>>) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type !== 'tool_use') continue;
        const input = block.input as Record<string, unknown> | undefined;
        const path = (input?.file_path ?? input?.path) as string | undefined;
        if (path && typeof path === 'string') paths.push(path);
      }
    }
    return paths;
  } catch { return []; }
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

  // Truncate at a JSON blob that starts on its own line — Claude Code appends
  // metadata like {"type":"usage",...} on a new line after the visible text.
  // Only match \n{" so inline JSON within the response is not cut off.
  const jsonIdx = trimmed.search(/\n\{"/);
  if (jsonIdx !== -1) {
    const before = trimmed.slice(0, jsonIdx).trim();
    if (before) return before;
    return '';
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
          // Drop injected blocks: system tags, JSON blobs, quota notices, skill content,
          // and Claude Code system instructions (compact-return prompt etc.).
          // Real user messages are conversational and short; anything > 4000 chars is
          // injected system/skill content (skill guides are tens of thousands of chars).
          .filter((t) =>
            t.length > 0 &&
            t.length < 4000 &&
            !t.startsWith('<') &&
            !t.startsWith('[') &&
            !t.startsWith('{') &&
            !t.startsWith('Base directory for this skill:') &&
            !t.startsWith('### Skill:') &&
            !t.startsWith('The user stepped away') &&
            !t.includes('Prior knowledge:'),
          );

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
  const sessionFilePaths = new Set<string>(); // unique file paths across the session

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

        // Count new unique file paths seen in this request's history
        const newPaths = extractToolFilePaths(body).filter(p => !sessionFilePaths.has(p));
        for (const p of newPaths) sessionFilePaths.add(p);

        const pricing = modelPricing(extractModel(body));

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
            let accInputTokens = 0;
            let accOutputTokens = 0;
            let remainder = '';

            proxyRes.on('data', (chunk: Buffer) => {
              res.write(chunk);

              const raw = remainder + chunk.toString('utf8');
              const lines = raw.split('\n');
              remainder = lines.pop() ?? '';

              const { text, stopReason, inputTokens, outputTokens } = parseSSE(lines.join('\n'));
              accumulated += text;
              accInputTokens += inputTokens;
              accOutputTokens += outputTokens;
              if (stopReason) accStopReason = stopReason;
            });

            proxyRes.on('end', () => {
              if (remainder) {
                const { text, stopReason, inputTokens, outputTokens } = parseSSE(remainder);
                accumulated += text;
                accInputTokens += inputTokens;
                accOutputTokens += outputTokens;
                if (stopReason) accStopReason = stopReason;
              }
              res.end();

              if (accStopReason === 'end_turn') {
                void save(sessionId, accumulated, 'stdout');
                const cost =
                  (accInputTokens * pricing.input + accOutputTokens * pricing.output) / 1_000_000;
                void updateSessionStats(sessionId, {
                  calls: 1,
                  tokens: accInputTokens + accOutputTokens,
                  cost,
                  ...(newPaths.length > 0 && { files: newPaths.length }),
                });
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
