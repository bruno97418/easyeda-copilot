import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

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
        version: '0.1.0',
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

    // The bridge never auto-approves shell or filesystem escalation.
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.respond(id, { decision: 'decline' });
      return;
    }

    // EasyEDA Copilot asks Codex for MCP tool approval through an MCP elicitation.
    // Accept only the known local easyeda-copilot server; decline every other elicitation.
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

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    try {
      await codex.ensureReady();
      sendJson(res, 200, { ok: true, threadId: codex.threadId });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/chat') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) req.destroy();
    });
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const message = String(body.message || '').trim();
        if (!message) return sendJson(res, 400, { error: 'Message vide' });
        const text = await codex.chat(message);
        sendJson(res, 200, { text });
      } catch (error) {
        console.error('[codex-bridge] chat failed:', error);
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[codex-bridge] Listening on http://${HOST}:${PORT}`);
  console.log('[codex-bridge] Uses your existing Codex ChatGPT login; no OpenAI API key is required.');
});
