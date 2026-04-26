import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { appendSessionOutput } from '../api/backendClient';

const DEBUG_LOG = '/tmp/ashral-debug.log';
function dbg(msg: string): void {
  fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} [openai-proxy] ${msg}\n`);
}

const OPENAI_HOST = 'api.openai.com';
const CHUNK_MAX_CHARS = 14_000;

/**
 * Parse OpenAI Chat Completions streaming SSE chunks.
 * Format: data: {"choices":[{"delta":{"content":"..."},"finish_reason":null}]}
 */
function parseChatCompletionsSSE(raw: string): { text: string; done: boolean } {
  let text = '';
  let done = false;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') { done = true; continue; }
    try {
      const ev = JSON.parse(payload) as Record<string, unknown>;
      const choices = ev.choices as Array<Record<string, unknown>> | undefined;
      if (choices?.length) {
        const delta = choices[0].delta as Record<string, unknown> | undefined;
        if (typeof delta?.content === 'string') text += delta.content;
        if (choices[0].finish_reason != null) done = true;
      }
    } catch { /* malformed */ }
  }
  return { text, done };
}

/**
 * Parse OpenAI Responses API SSE chunks.
 * Format: event: response.output_text.delta\ndata: {"delta":"..."}
 */
function parseResponsesAPISSE(raw: string): { text: string; done: boolean } {
  let text = '';
  let done = false;
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('event: response.done')) { done = true; continue; }
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') { done = true; continue; }
    try {
      const ev = JSON.parse(payload) as Record<string, unknown>;
      if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
        text += ev.delta;
      }
      // response.output_text.done has the complete text — prefer it over delta accumulation
      if (ev.type === 'response.output_text.done' && typeof ev.text === 'string') {
        text = ev.text; // replace — this is the canonical full text
      }
      if (ev.type === 'response.done' || ev.type === 'response.completed') {
        done = true;
      }
    } catch { /* malformed */ }
  }
  return { text, done };
}

/**
 * Extract the last user message from an OpenAI request body.
 * Handles both Chat Completions ({ messages: [...] }) and
 * Responses API ({ input: [...] | string }) formats.
 */
function extractUserMessage(body: Buffer): string | null {
  try {
    const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;

    // Responses API: input can be a plain string
    if (typeof json.input === 'string' && json.input.trim()) {
      return json.input.trim();
    }

    const messages = (json.messages ?? json.input) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(messages)) return null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;
      if (typeof msg.content === 'string') {
        const t = msg.content.trim();
        if (t) return t;
      }
      if (Array.isArray(msg.content)) {
        const parts = (msg.content as Array<Record<string, unknown>>)
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => (b.text as string).trim())
          .filter(Boolean);
        const joined = parts.join('\n').trim();
        if (joined) return joined;
      }
    }
  } catch { /* not valid JSON */ }
  return null;
}

async function saveChunked(sessionId: string, text: string, stream: 'stdout' | 'stderr'): Promise<void> {
  const t = text.trim();
  if (!t) return;
  for (let i = 0; i < t.length; i += CHUNK_MAX_CHARS) {
    await appendSessionOutput(sessionId, t.slice(i, i + CHUNK_MAX_CHARS), stream).catch(() => {});
  }
}

export interface ProxyHandle {
  port: number;
  stop: () => Promise<void>;
}

/**
 * Temporarily patches ~/.codex/config.toml to add openai_base_url pointing to
 * our local proxy. Uses the real CODEX_HOME so all auth state (state_5.sqlite
 * etc.) is available. Returns a restore function to call after Codex exits.
 */
export async function patchCodexConfig(proxyPort: number): Promise<() => Promise<void>> {
  const realHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const configPath = path.join(realHome, 'config.toml');

  const original = await fsp.readFile(configPath, 'utf8').catch(() => '');

  // Remove any existing openai_base_url line, then prepend ours
  const cleaned = original.replace(/^openai_base_url\s*=.*\n?/m, '');
  const patched = `openai_base_url = "http://127.0.0.1:${proxyPort}/v1"\n${cleaned}`;
  await fsp.writeFile(configPath, patched);

  dbg(`patchCodexConfig port=${proxyPort} configPath=${configPath}`);

  return async () => {
    await fsp.writeFile(configPath, original).catch((e: unknown) => dbg(`restore config FAILED: ${e}`));
    dbg('patchCodexConfig: config restored');
  };
}

export function startOpenAIProxy(sessionId: string): Promise<ProxyHandle> {
  let lastSavedUserMsg = '';

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const bodyChunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));

      req.on('end', () => {
        const body = Buffer.concat(bodyChunks);
        dbg(`request ${req.method} ${req.url} bodyLen=${body.length}`);

        // Save the latest user message
        const userMsg = extractUserMessage(body);
        dbg(`userMsg=${userMsg ? `"${userMsg.slice(0, 60)}"` : 'null'}`);
        if (userMsg && userMsg !== lastSavedUserMsg) {
          lastSavedUserMsg = userMsg;
          void saveChunked(sessionId, userMsg, 'stderr')
            .then(() => dbg('saved user msg ok'))
            .catch((e: unknown) => dbg(`save user msg FAILED: ${e}`));
        }

        const headers: Record<string, string | string[] | undefined> = {
          ...req.headers,
          host: OPENAI_HOST,
        };
        delete headers['accept-encoding'];

        const proxyReq = https.request(
          { hostname: OPENAI_HOST, port: 443, path: req.url, method: req.method, headers },
          (proxyRes) => {
            dbg(`upstream status=${proxyRes.statusCode}`);
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);

            let accumulated = '';
            let remainder = '';

            proxyRes.on('data', (chunk: Buffer) => {
              res.write(chunk);

              const raw = remainder + chunk.toString('utf8');
              const lines = raw.split('\n');
              remainder = lines.pop() ?? '';
              const joined = lines.join('\n');

              // Try Chat Completions format first, then Responses API
              const chat = parseChatCompletionsSSE(joined);
              const resp = parseResponsesAPISSE(joined);
              accumulated += chat.text || resp.text;
            });

            proxyRes.on('end', () => {
              // Flush the last partial SSE line
              if (remainder) {
                const chat = parseChatCompletionsSSE(remainder);
                const resp = parseResponsesAPISSE(remainder);
                accumulated += chat.text || resp.text;
              }
              res.end();

              dbg(`response done accumulated=${accumulated.length} preview="${accumulated.slice(0, 80).replace(/\n/g, '↵')}"`);
              // Save the complete assistant response
              void saveChunked(sessionId, accumulated, 'stdout')
                .then(() => dbg('saved assistant response ok'))
                .catch((e: unknown) => dbg(`save assistant response FAILED: ${e}`));
            });

            proxyRes.on('error', (e) => { dbg(`upstream error: ${e}`); res.end(); });
          },
        );

        proxyReq.on('error', (e) => { dbg(`proxyReq error: ${e}`); res.writeHead(502); res.end(); });
        proxyReq.write(body);
        proxyReq.end();
      });

      req.on('error', () => res.end());
    });

    server.on('upgrade', (_req, socket) => {
      // Reject WebSocket upgrades so Codex falls back to HTTP SSE,
      // where we can intercept and capture the streamed content.
      (socket as import('net').Socket).write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      (socket as import('net').Socket).destroy();
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind OpenAI proxy port'));
        return;
      }
      resolve({
        port: addr.port,
        stop: () => new Promise((done) => server.close(() => done())),
      });
    });

    server.on('error', reject);
  });
}
