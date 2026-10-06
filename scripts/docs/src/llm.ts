import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { sleep } from './util.ts';

export interface LlmRequest {
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
  /** Deterministic stand-in output; only the mock provider uses it. */
  fake?: () => unknown;
}
export interface LlmResponse { text: string; inputTokens: number; outputTokens: number }
export interface Provider { name: string; complete(req: LlmRequest): Promise<LlmResponse> }

export const estimateTokens = (s: string): number => Math.ceil(s.length / 3.6);

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private readonly key: string;
  private readonly baseUrl: string;
  constructor(key = process.env.ANTHROPIC_API_KEY, baseUrl = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com') {
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set (use --provider claude-cli to go through your logged-in Claude Code instead)');
    this.key = key;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body = JSON.stringify({ model: req.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: 'user', content: req.prompt }] });
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let netErr: unknown;
      try {
        res = await fetch(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
          body,
        });
      } catch (e) {
        netErr = e;
      }
      if (res?.ok) {
        const json = (await res.json()) as { content: { type: string; text?: string }[]; usage?: { input_tokens: number; output_tokens: number } };
        const text = json.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
        return { text, inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 };
      }
      const retryable = !res || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 6) {
        const detail = res ? `${res.status} ${(await res.text()).slice(0, 300)}` : String(netErr);
        throw new Error(`Anthropic API error: ${detail}`);
      }
      const retryAfter = Number(res?.headers.get('retry-after'));
      await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 1000 * 2 ** attempt)) + Math.random() * 500);
    }
  }
}

/** Runs the CLI under a separate Claude Code profile only when DOCS_CLAUDE_CONFIG_DIR is set; otherwise the user's normal profile is used. */
const cliEnv = () => (process.env.DOCS_CLAUDE_CONFIG_DIR ? { ...process.env, CLAUDE_CONFIG_DIR: process.env.DOCS_CLAUDE_CONFIG_DIR } : process.env);

/** Runs a one-shot headless `claude -p` per call, tool-less and outside the repo (no CLAUDE.md, no hooks). Slower, but needs no API key. */
export class ClaudeCliProvider implements Provider {
  readonly name = 'claude-cli';
  complete(req: LlmRequest): Promise<LlmResponse> {
    return new Promise((resolve, reject) => {
      const args = ['-p', '--model', req.model, '--tools', '', '--no-session-persistence', '--system-prompt', req.system, '--output-format', 'text'];
      const child = spawn(process.env.CLAUDE_BIN ?? 'claude', args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], env: cliEnv() });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0 && out.trim()) resolve({ text: out, inputTokens: estimateTokens(req.system + req.prompt), outputTokens: estimateTokens(out) });
        else reject(new Error(`claude exited with ${code}: ${(err || out).slice(0, 300)}`));
      });
      child.stdin.end(req.prompt);
    });
  }
}

export class MockProvider implements Provider {
  readonly name = 'mock';
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const text = JSON.stringify(req.fake ? req.fake() : { note: 'mock' });
    return { text, inputTokens: estimateTokens(req.prompt), outputTokens: estimateTokens(text) };
  }
}

export function makeProvider(name: string): Provider {
  if (name === 'mock') return new MockProvider();
  if (name === 'claude-cli') return new ClaudeCliProvider();
  if (name === 'anthropic') return new AnthropicProvider();
  if (name === 'auto') return process.env.ANTHROPIC_API_KEY ? new AnthropicProvider() : new ClaudeCliProvider();
  throw new Error(`unknown provider "${name}" (anthropic | claude-cli | mock | auto)`);
}

/** Pulls the first balanced JSON object out of a model reply (tolerates code fences and chatter). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start < 0) throw new Error('no JSON object in reply');
  let depth = 0;
  let inStr = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object in reply');
}
