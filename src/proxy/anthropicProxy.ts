import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import { appendSessionOutput, updateSessionStats, appendSessionDiff, type FileDiffPayload } from '../api/backendClient';

function dbg(msg: string): void {
  fs.appendFileSync('/tmp/ashral-debug.log', `${new Date().toISOString()} [proxy] ${msg}\n`);
}

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

const DIFF_CONTENT_LIMIT = 3000;

function extractFileDiffs(body: Buffer): FileDiffPayload[] {
  try {
    const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    const messages = json.messages;
    if (!Array.isArray(messages)) return [];

    const diffs: FileDiffPayload[] = [];
    for (const msg of messages as Array<Record<string, unknown>>) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type !== 'tool_use') continue;
        const name = (block.name as string | undefined) ?? '';
        const id = block.id as string | undefined;
        if (!id) continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        const cmd = input.command as string | undefined;

        // Claude Code's built-in Edit tool: { file_path, old_string, new_string }
        if (name === 'Edit') {
          const path = (input.file_path ?? input.path) as string | undefined;
          const oldStr = (input.old_string ?? input.old_str) as string | undefined;
          const newStr = (input.new_string ?? input.new_str) as string | undefined;
          if (path && newStr !== undefined) {
            diffs.push({
              toolUseId: id,
              path,
              type: 'str_replace',
              ...(typeof oldStr === 'string' && { oldStr: oldStr.slice(0, DIFF_CONTENT_LIMIT) }),
              newStr: newStr.slice(0, DIFF_CONTENT_LIMIT),
            });
          }
        // Claude Code's built-in Write tool: { file_path, content }
        } else if (name === 'Write') {
          const path = (input.file_path ?? input.path) as string | undefined;
          const content = (input.content ?? input.file_text) as string | undefined;
          if (path && content !== undefined) {
            diffs.push({
              toolUseId: id,
              path,
              type: 'write_file',
              newStr: content.slice(0, DIFF_CONTENT_LIMIT),
            });
          }
        // Legacy str_replace_based_edit_tool format
        } else if (name.toLowerCase().includes('str_replace') || name === 'edit_file') {
          const isCreate = (input.command as string | undefined) === 'create' || (input.command as string | undefined) === 'write';
          const path = (input.path ?? input.file_path) as string | undefined;
          if (isCreate) {
            const content = (input.file_text ?? input.new_str ?? input.content) as string | undefined;
            if (path && content !== undefined) {
              diffs.push({ toolUseId: id, path, type: 'create_file', newStr: content.slice(0, DIFF_CONTENT_LIMIT) });
            }
          } else {
            const newStr = (input.new_str ?? input.new_string) as string | undefined;
            if (path && newStr !== undefined) {
              diffs.push({
                toolUseId: id, path, type: 'str_replace',
                ...(typeof (input.old_str ?? input.old_string) === 'string' && {
                  oldStr: ((input.old_str ?? input.old_string) as string).slice(0, DIFF_CONTENT_LIMIT),
                }),
                newStr: newStr.slice(0, DIFF_CONTENT_LIMIT),
              });
            }
          }
        } else if (name === 'write_file' || name === 'create_file') {
          const path = (input.file_path ?? input.path) as string | undefined;
          const content = (input.content ?? input.file_text) as string | undefined;
          if (path && content !== undefined) {
            diffs.push({
              toolUseId: id, path,
              type: name === 'create_file' ? 'create_file' : 'write_file',
              newStr: content.slice(0, DIFF_CONTENT_LIMIT),
            });
          }
        }
      }
    }
    return diffs;
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

  // Strip Claude Code's ✳ annotation lines (recap, timing, etc.) — these are
  // appended by Claude Code's CLI, not part of the actual AI response.
  const lines = trimmed.split('\n');
  const firstAnnotation = lines.findIndex(l => l.trimStart().startsWith('✳'));
  const cleaned = (firstAnnotation === -1 ? lines : lines.slice(0, firstAnnotation))
    .join('\n').trim();
  return cleaned;
}

async function save(sessionId: string, text: string, stream: 'stdout' | 'stderr'): Promise<void> {
  const trimmed = stream === 'stdout' ? stripInternalMetadata(text) : text.trim();
  if (!trimmed) return;
  for (let i = 0; i < trimmed.length; i += CHUNK_MAX_CHARS) {
    await appendSessionOutput(sessionId, trimmed.slice(i, i + CHUNK_MAX_CHARS), stream).catch(() => {});
  }
}

// Returns true for any text block that is Claude Code system injection, not real user input.
function isInjectedBlock(t: string): boolean {
  return (
    t.startsWith('<') ||
    t.startsWith('[') ||
    t.startsWith('{') ||
    t.includes('[SUGGESTION MODE:') ||
    t.startsWith('Base directory for this skill:') ||
    t.startsWith('### Skill:') ||
    t.startsWith('The user stepped away') ||
    t.includes('Prior knowledge:')
  );
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
        try { JSON.parse(text); continue; } catch { /* not JSON */ }
        if (isInjectedBlock(text)) continue;
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
          .filter((t) => t.length > 0 && t.length < 4000 && !isInjectedBlock(t));

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
  const seenToolIds = new Set<string>();

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const bodyChunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));

      req.on('end', () => {
        const body = Buffer.concat(bodyChunks);

        // Log every request so we can verify proxy is active and see message structure
        try {
          const j = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          const msgs = Array.isArray(j.messages) ? j.messages as Array<Record<string, unknown>> : [];
          const toolUseCount = msgs.filter(m => m.role === 'assistant' && Array.isArray(m.content))
            .flatMap(m => (m.content as Array<Record<string, unknown>>).filter(b => b.type === 'tool_use'))
            .length;
          const toolNames = msgs.filter(m => m.role === 'assistant' && Array.isArray(m.content))
            .flatMap(m => (m.content as Array<Record<string, unknown>>).filter(b => b.type === 'tool_use').map(b => b.name as string))
            .filter((v, i, a) => a.indexOf(v) === i);
          dbg(`request sid=${sessionId} msgs=${msgs.length} tool_use=${toolUseCount} names=${toolNames.join(',') || 'none'}`);
        } catch { dbg('request: body not JSON'); }

        const userMsg = extractUserMessage(body);
        if (userMsg && userMsg !== lastSavedUserMsg) {
          lastSavedUserMsg = userMsg;
          void save(sessionId, userMsg, 'stderr');
        }

        // Count new unique file paths seen in this request's history
        const newPaths = extractToolFilePaths(body).filter(p => !sessionFilePaths.has(p));
        for (const p of newPaths) sessionFilePaths.add(p);

        // Extract file diffs — only post ones not yet seen this session
        const allDiffs = extractFileDiffs(body);
        const newDiffs = allDiffs.filter(d => !seenToolIds.has(d.toolUseId));
        for (const d of newDiffs) seenToolIds.add(d.toolUseId);
        if (newDiffs.length > 0) {
          dbg(`diffs new (${newDiffs.length}): ${newDiffs.map(d => `${d.type}:${d.path}`).join(', ')}`);
        } else if (allDiffs.length > 0) {
          dbg(`diffs seen (${allDiffs.length} already deduped): ${allDiffs.map(d => d.path).join(', ')}`);
        }
        for (const d of newDiffs) {
          void appendSessionDiff(sessionId, d).catch((err: unknown) => {
            dbg(`appendSessionDiff FAILED path=${d.path}: ${err}`);
          });
        }

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
