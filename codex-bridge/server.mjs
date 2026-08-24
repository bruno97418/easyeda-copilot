import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';

const HOST = process.env.EASYEDA_CODEX_HOST || '127.0.0.1';
const PORT = Number(process.env.EASYEDA_CODEX_PORT || 8790);
const CODEX_COMMAND = process.env.CODEX_COMMAND || (process.platform === 'win32' ? 'codex.cmd' : 'codex');

class CodexAppServerClient {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.threadId = null;
    this.activeTurn = null;
    this.readyPromise = null;
  }

  async ensureReady() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.start();
    try {
      return await this.readyPromise;
    } catch (error) {
      this.readyPromise = null;
      throw error;
    }
  }

  async start() {
    this.proc = spawn(CODEX_COMMAND, ['app-server', '--listen', 'stdio://'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
      env: process.env,
    });

    this.proc.on('exit', (code, signal) => {
      const error = new Error(`Codex App Server stopped (code=${code}, signal=${signal})`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      if (this.activeTurn?.reject) this.activeTurn.reject(error);
      this.activeTurn = null;
      this.proc = null;
      this.threadId = null;
      this.readyPromise = null;
    });

    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[codex] ${text}`);
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (error) {
        console.error('[codex-bridge] Invalid JSONL from Codex:', line, error);
      }
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'easyeda_copilot_local',
        title: 'EasyEDA Copilot Local Codex Bridge',
        version: '0.2.0',
      },
      capabilities: {
        experimentalApi: false,
      },
    });
    this.notify('initialized', {});

    const started = await this.request('thread/start', {
      cwd: process.cwd(),
      ephemeral: false,
    });
    this.threadId = started?.thread?.id;
    if (!this.threadId) throw new Error('Codex did not return a thread id');

    console.log(`[codex-bridge] Codex ready, thread ${this.threadId}`);
  }

  write(message) {
    if (!this.proc?.stdin?.writable) throw new Error('Codex App Server is not running');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  handleMessage(message) {
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.id != null && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (!message.method) return;
    const params = message.params || {};

    if (message.method === 'item/agentMessage/delta' && this.activeTurn) {
      const delta = params.delta ?? params.text ?? '';
      if (typeof delta === 'string') this.activeTurn.text += delta;
      return;
    }

    if (message.method === 'item/completed' && this.activeTurn) {
      const item = params.item || {};
      if (item.type === 'agentMessage') {
        const text = item.text ?? item.content ?? item.message;
        if (typeof text === 'string' && !this.activeTurn.text.trim()) this.activeTurn.text = text;
      }
      return;
    }

    if (message.method === 'turn/completed' && this.activeTurn) {
      const active = this.activeTurn;
      this.activeTurn = null;
      const status = params.turn?.status || params.status;
      if (status === 'failed') {
        active.reject(new Error(params.turn?.error?.message || params.error?.message || 'Codex turn failed'));
      } else {
        active.resolve(active.text.trim() || 'Terminé.');
      }
    }
  }

  handleServerRequest(message) {
    const { id, method, params = {} } = message;

    // Never auto-approve shell commands or filesystem edits made by Codex itself.
    // EasyEDA changes must go through the explicitly configured EasyEDA MCP server.
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.respond(id, { decision: 'decline' });
      return;
    }

    // Approve only MCP tool calls from the known EasyEDA Copilot MCP server.
    if (method === 'mcpServer/elicitation/request') {
      const meta = params?.meta || params?.request?.meta || {};
      const serverName = params.serverName || '';
      const isEasyEdaApproval = serverName === 'easyeda-copilot' && meta.codex_approval_kind === 'mcp_tool_call';
      if (isEasyEdaApproval) {
        this.respond(id, { action: 'accept', content: { decision: 'always' } });
      } else {
        this.respond(id, { action: 'decline', content: null });
      }
      return;
    }

    if (method === 'item/tool/requestUserInput') {
      this.respond(id, { answers: {} });
      return;
    }

    console.warn(`[codex-bridge] Unsupported server request: ${method}`);
    this.respond(id, { decision: 'decline' });
  }

  async chat(userText) {
    await this.ensureReady();
    if (!this.threadId) throw new Error('Codex thread is not ready');
    if (this.activeTurn) throw new Error('A Codex turn is already running');

    const prompt = [
      'Réponds uniquement en français.',
      'Tu pilotes EasyEDA via le serveur MCP easyeda-copilot déjà configuré dans Codex.',
      'Utilise ce MCP pour lire ou modifier le document EasyEDA ouvert selon la demande.',
      'Ne modifie jamais le schéma lorsqu\'il est demandé de seulement analyser, vérifier ou expliquer.',
      '',
      userText,
    ].join('\n');

    return await new Promise(async (resolve, reject) => {
      this.activeTurn = { text: '', resolve, reject };
      try {
        await this.request('turn/start', {
          threadId: this.threadId,
          input: [{ type: 'text', text: prompt }],
        });
      } catch (error) {
        this.activeTurn = null;
        reject(error);
      }
    });
  }
}

const codex = new CodexAppServerClient();

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    ...extra,
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, corsHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  }));
  res.end(body);
}

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4_000_000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text' || part?.type === 'input_text') return part.text || '';
    return '';
  }).filter(Boolean).join('\n');
}

function extractPromptFromChat(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
  if (lastUser) return messageText(lastUser.content);

  const all = messages.map((m) => messageText(m?.content)).filter(Boolean);
  return all.at(-1) || '';
}

function extractPromptFromResponses(body) {
  if (typeof body.input === 'string') return body.input;
  if (!Array.isArray(body.input)) return '';
  const texts = [];
  for (const item of body.input) {
    if (typeof item === 'string') texts.push(item);
    else if (item?.role === 'user') texts.push(messageText(item.content));
    else if (item?.type === 'message' && item?.role === 'user') texts.push(messageText(item.content));
  }
  return texts.filter(Boolean).at(-1) || '';
}

function sendChatCompletion(res, text, model, stream) {
  const id = `chatcmpl_${crypto.randomUUID().replaceAll('-', '')}`;
  if (!stream) {
    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'codex-chatgpt',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    return;
  }

  res.writeHead(200, corsHeaders({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  }));

  const first = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'codex-chatgpt',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  };
  const last = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'codex-chatgpt',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  };
  res.write(`data: ${JSON.stringify(first)}\n\n`);
  res.write(`data: ${JSON.stringify(last)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/health')) {
    try {
      await codex.ensureReady();
      sendJson(res, 200, { ok: true, threadId: codex.threadId });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    sendJson(res, 200, {
      object: 'list',
      data: [{ id: 'codex-chatgpt', object: 'model', owned_by: 'openai-chatgpt' }],
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/chat') {
    try {
      const body = await readJson(req);
      const message = String(body.message || '').trim();
      if (!message) return sendJson(res, 400, { error: 'Message vide' });
      const text = await codex.chat(message);
      sendJson(res, 200, { text });
    } catch (error) {
      console.error('[codex-bridge] chat failed:', error);
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    try {
      const body = await readJson(req);
      const prompt = extractPromptFromChat(body).trim();
      if (!prompt) return sendJson(res, 400, { error: { message: 'No user message found' } });
      const text = await codex.chat(prompt);
      sendChatCompletion(res, text, body.model, Boolean(body.stream));
    } catch (error) {
      console.error('[codex-bridge] chat completion failed:', error);
      sendJson(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/responses') {
    try {
      const body = await readJson(req);
      const prompt = extractPromptFromResponses(body).trim();
      if (!prompt) return sendJson(res, 400, { error: { message: 'No user input found' } });
      const text = await codex.chat(prompt);
      const responseId = `resp_${crypto.randomUUID().replaceAll('-', '')}`;
      sendJson(res, 200, {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model: body.model || 'codex-chatgpt',
        output: [{
          id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        }],
        output_text: text,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      });
    } catch (error) {
      console.error('[codex-bridge] responses failed:', error);
      sendJson(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[codex-bridge] Listening on http://${HOST}:${PORT}`);
  console.log(`[codex-bridge] OpenAI-compatible base URL: http://${HOST}:${PORT}/v1`);
  console.log('[codex-bridge] Uses your existing Codex ChatGPT login; no OpenAI API key is required.');
});
