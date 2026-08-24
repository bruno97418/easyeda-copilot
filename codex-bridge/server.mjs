import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { buildSchematicMethodRules, SCHEMATIC_METHOD_VERSION } from './schematic-method.mjs';

const HOST = process.env.EASYEDA_CODEX_HOST || '127.0.0.1';
const PORT = Number(process.env.EASYEDA_CODEX_PORT || 8790);
const CODEX_COMMAND = process.env.CODEX_COMMAND || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
const MAX_RECOVERY_RETRIES = Number(process.env.EASYEDA_CODEX_RECOVERY_RETRIES || 1);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    if (this.proc && this.threadId) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.start();
    try { await this.readyPromise; }
    finally { this.readyPromise = null; }
  }

  async start() {
    const args = [
      '--ask-for-approval', 'on-request',
      '--sandbox', 'workspace-write',
      '--search',
      'app-server', '--listen', 'stdio://',
    ];

    this.proc = spawn(CODEX_COMMAND, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
      env: process.env,
    });

    this.proc.on('exit', (code, signal) => {
      const error = new Error(`Codex App Server stopped (code=${code}, signal=${signal})`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
      if (this.activeTurn?.reject) this.activeTurn.reject(error);
      this.activeTurn = null;
      this.proc = null;
      this.threadId = null;
    });

    this.proc.stderr.on('data', chunk => {
      const text = chunk.toString().trim();
      if (text) console.error(`[codex] ${text}`);
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', line => {
      if (!line.trim()) return;
      try { this.handleMessage(JSON.parse(line)); }
      catch (error) { console.error('[codex-bridge] Invalid JSONL from Codex:', line, error); }
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'easyeda_copilot_local',
        title: 'EasyEDA Copilot Local Codex Bridge',
        version: '0.5.0',
      },
      capabilities: { experimentalApi: false },
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

  request(method, params = {}, timeoutMs = 120000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method, params = {}) { this.write({ method, params }); }
  respond(id, result) { this.write({ id, result }); }

  handleMessage(message) {
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
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
      if (status === 'failed') active.reject(new Error(params.turn?.error?.message || params.error?.message || 'Codex turn failed'));
      else active.resolve(active.text.trim() || 'Terminé.');
    }
  }

  handleServerRequest(message) {
    const { id, method, params = {} } = message;

    // Shell and direct filesystem changes stay blocked. EasyEDA changes must pass through MCP.
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.respond(id, { decision: 'decline' });
      return;
    }

    // Persistently approve only EasyEDA MCP tool calls.
    if (method === 'mcpServer/elicitation/request') {
      const meta = params?._meta || params?.meta || params?.request?._meta || params?.request?.meta || {};
      const serverName = params.serverName || params?.request?.serverName || '';
      const approvalKind = meta.codex_approval_kind || meta.approval_kind || '';
      const isEasyEda = serverName === 'easyeda-copilot';
      const isToolCall = !approvalKind || approvalKind === 'mcp_tool_call';

      if (isEasyEda && isToolCall) {
        this.respond(id, {
          action: 'accept',
          content: { __approval: 'accept_always' },
          _meta: null,
        });
        console.log('[codex-bridge] EasyEDA MCP tool approved permanently for this session');
      } else {
        this.respond(id, { action: 'decline', content: null, _meta: null });
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

  buildPrompt(userText, recovery = false) {
    const rules = [
      'Réponds uniquement en français.',
      'Tu pilotes EasyEDA uniquement via le serveur MCP easyeda-copilot déjà configuré dans Codex.',
      'Utilise ce MCP pour lire ou modifier le document EasyEDA ouvert selon la demande.',
      'Ne modifie jamais le schéma lorsqu’il est demandé de seulement analyser, vérifier ou expliquer.',
      ...buildSchematicMethodRules(),
    ];
    if (recovery) rules.push('REPRISE APRÈS COUPURE : inspecte d’abord le schéma existant, compare références, positions, nets et blocs fonctionnels, puis continue sans dupliquer ce qui a déjà été créé.');
    return `${rules.join('\n')}\n\nDEMANDE UTILISATEUR :\n${userText}`;
  }

  async runTurn(prompt) {
    await this.ensureReady();
    if (!this.threadId) throw new Error('Codex thread is not ready');
    if (this.activeTurn) throw new Error('A Codex turn is already running');

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

  isTransportError(error) {
    const text = String(error?.message || error).toLowerCase();
    return text.includes('transport channel closed') || text.includes('app server stopped') || text.includes('broken pipe') || text.includes('econnreset');
  }

  async chat(userText) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RECOVERY_RETRIES; attempt++) {
      try {
        return await this.runTurn(this.buildPrompt(userText, attempt > 0));
      } catch (error) {
        lastError = error;
        if (attempt >= MAX_RECOVERY_RETRIES || !this.isTransportError(error)) throw error;
        console.warn('[codex-bridge] Codex transport interrupted; restarting and resuming safely...');
        this.proc = null;
        this.threadId = null;
        this.readyPromise = null;
        await sleep(1500);
      }
    }
    throw lastError;
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
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 4_000_000) { reject(new Error('Request too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text' || part?.type === 'input_text') return part.text || '';
    return '';
  }).filter(Boolean).join('\n');
}

function extractPromptFromChat(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find(m => m?.role === 'user');
  return lastUser ? messageText(lastUser.content) : messages.map(m => messageText(m?.content)).filter(Boolean).at(-1) || '';
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
      id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model || 'codex-chatgpt',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    return;
  }

  res.writeHead(200, corsHeaders({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  }));
  const first = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: model || 'codex-chatgpt', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] };
  const last = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: model || 'codex-chatgpt', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
  res.write(`data: ${JSON.stringify(first)}\n\n`);
  res.write(`data: ${JSON.stringify(last)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return; }

  if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/health')) {
    try { await codex.ensureReady(); sendJson(res, 200, { ok: true, threadId: codex.threadId }); }
    catch (error) { sendJson(res, 503, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    sendJson(res, 200, { object: 'list', data: [{ id: 'codex-chatgpt', object: 'model', owned_by: 'openai-chatgpt' }] });
    return;
  }

  try {
    if (req.method === 'POST' && req.url === '/chat') {
      const body = await readJson(req);
      const message = String(body.message || '').trim();
      if (!message) return sendJson(res, 400, { error: 'Message vide' });
      return sendJson(res, 200, { text: await codex.chat(message) });
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = await readJson(req);
      const prompt = extractPromptFromChat(body).trim();
      if (!prompt) return sendJson(res, 400, { error: { message: 'No user message found' } });
      return sendChatCompletion(res, await codex.chat(prompt), body.model, Boolean(body.stream));
    }

    if (req.method === 'POST' && req.url === '/v1/responses') {
      const body = await readJson(req);
      const prompt = extractPromptFromResponses(body).trim();
      if (!prompt) return sendJson(res, 400, { error: { message: 'No user input found' } });
      const text = await codex.chat(prompt);
      const responseId = `resp_${crypto.randomUUID().replaceAll('-', '')}`;
      return sendJson(res, 200, {
        id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: body.model || 'codex-chatgpt',
        output: [{ id: `msg_${crypto.randomUUID().replaceAll('-', '')}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
        output_text: text,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      });
    }
  } catch (error) {
    console.error('[codex-bridge] request failed:', error);
    return sendJson(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.keepAliveTimeout = 10 * 60 * 1000;
server.headersTimeout = 10 * 60 * 1000 + 5000;
server.requestTimeout = 0;

server.listen(PORT, HOST, () => {
  console.log(`[codex-bridge] Listening on http://${HOST}:${PORT}`);
  console.log(`[codex-bridge] OpenAI-compatible base URL: http://${HOST}:${PORT}/v1`);
  console.log('[codex-bridge] Uses your existing Codex ChatGPT login; no OpenAI API key is required.');
  console.log('[codex-bridge] EasyEDA MCP auto-approval + live stock-search policy enabled.');
  console.log(`[codex-bridge] Generic Golden Schematic method v${SCHEMATIC_METHOD_VERSION} enabled (7805 is regression example only).`);
});
