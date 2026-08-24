import http from 'node:http';
import crypto from 'node:crypto';

const HOST = process.env.EASYEDA_ADAPTER_HOST || '127.0.0.1';
const PORT = Number(process.env.EASYEDA_ADAPTER_PORT || 8790);
const CODEX_BASE = process.env.EASYEDA_CODEX_INTERNAL_BASE || 'http://127.0.0.1:8791/v1';
const MAX_RETRIES = Number(process.env.EASYEDA_CODEX_RETRIES || 2);
const RETRY_DELAY_MS = Number(process.env.EASYEDA_CODEX_RETRY_DELAY_MS || 2500);
const streams = new Map();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function headers(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization, x-eda-user',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    ...extra,
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, headers({
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
      if (raw.length > 4_000_000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function extractPrompt(body) {
  const context = Array.isArray(body?.context) ? body.context : [];
  const lastHuman = [...context].reverse().find(m => m?.role === 'human');
  if (!lastHuman) return '';

  const parts = [String(lastHuman.content || '').trim()];
  if (lastHuman.options && Object.keys(lastHuman.options).length) {
    parts.push('Contexte EasyEDA joint à la demande :');
    parts.push(JSON.stringify(lastHuman.options));
  }
  return parts.filter(Boolean).join('\n\n');
}

function withDesignPolicy(prompt, retry = false) {
  const policy = [
    'RÈGLES PERMANENTES EASYEDA :',
    '- Répondre uniquement en français.',
    '- Pour toute création ou modification, utiliser uniquement le MCP easyeda-copilot pour agir dans EasyEDA.',
    '- Avant de placer un composant, vérifier sa disponibilité actuelle chez LCSC/JLCPCB lorsque cette information est accessible.',
    '- Utiliser la recherche web en direct si nécessaire pour confirmer les références LCSC, le statut Basic/Extended et le stock actuel.',
    '- Ne pas sélectionner volontairement une référence à stock nul. Chercher automatiquement une alternative électriquement compatible.',
    '- Pour une alternative, vérifier fonction, tension, courant, tolérance, température, boîtier/empreinte et brochage avant remplacement.',
    '- Préférer les références JLCPCB Basic/standard, en stock élevé et avec une empreinte courante, à caractéristiques équivalentes.',
    '- Si le stock exact ne peut pas être confirmé, ne pas inventer de quantité : indiquer STOCK NON VÉRIFIÉ et éviter ce composant critique si une référence vérifiée existe.',
    '- À la fin d’une conception, fournir les références fabricant + LCSC utilisées et l’état de disponibilité vérifié.',
    '- Avant de terminer, relire le schéma, vérifier les connexions, alimentations, masses, valeurs et corriger les erreurs évidentes.',
  ];

  if (retry) {
    policy.push(
      '- REPRISE APRÈS COUPURE : inspecter d’abord le schéma actuellement ouvert et reprendre la tâche sans dupliquer les composants ou réseaux déjà créés.'
    );
  }

  return `${policy.join('\n')}\n\nDEMANDE UTILISATEUR :\n${prompt}`;
}

async function postCodex(prompt, retry = false) {
  const response = await fetch(`${CODEX_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'codex-chatgpt',
      stream: false,
      messages: [{ role: 'user', content: withDesignPolicy(prompt, retry) }],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.error || `Codex bridge HTTP ${response.status}`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Réponse Codex vide');
  return String(text);
}

function isRetryable(error) {
  const text = String(error?.message || error).toLowerCase();
  return text.includes('fetch failed') ||
    text.includes('transport channel closed') ||
    text.includes('app server stopped') ||
    text.includes('socket') ||
    text.includes('econnreset') ||
    text.includes('econnrefused');
}

async function waitForBridge() {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${CODEX_BASE}/health`);
      if (r.ok) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

async function runCodex(body) {
  const prompt = extractPrompt(body);
  if (!prompt) throw new Error('Aucun message utilisateur trouvé');

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await postCodex(prompt, attempt > 0);
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_RETRIES || !isRetryable(error)) throw error;
      console.warn(`[easyeda-adapter] transport failure, retry ${attempt + 1}/${MAX_RETRIES}:`, error?.message || error);
      await sleep(RETRY_DELAY_MS);
      await waitForBridge();
    }
  }
  throw lastError;
}

function sendSse(res, event, data, id) {
  if (id) res.write(`id: ${id}\n`);
  if (event) res.write(`event: ${event}\n`);
  for (const line of String(data ?? '').split('\n')) res.write(`data: ${line}\n`);
  res.write('\n');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers());
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      const r = await fetch(`${CODEX_BASE}/health`).catch(() => null);
      sendJson(res, r?.ok ? 200 : 503, { ok: Boolean(r?.ok) });
      return;
    }

    if (req.method === 'POST' && req.url === '/v2/chat/s/stream/new') {
      const body = await readJson(req);
      const streamId = crypto.randomUUID();
      const entry = { promise: runCodex(body), stopped: false, createdAt: Date.now() };
      streams.set(streamId, entry);
      entry.promise.catch(() => undefined);
      sendJson(res, 200, { streamId });
      return;
    }

    const streamMatch = req.url?.match(/^\/v2\/chat\/s\/stream\/([^/?]+)(?:\?.*)?$/);
    if (req.method === 'GET' && streamMatch) {
      const streamId = decodeURIComponent(streamMatch[1]);
      const entry = streams.get(streamId);
      if (!entry) return sendJson(res, 404, { error: 'Unknown stream' });

      res.writeHead(200, headers({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      }));

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': keep-alive\n\n');
      }, 15000);

      try {
        const text = await entry.promise;
        if (!entry.stopped) {
          sendSse(res, 'mes_chunk', text, '1');
          sendSse(res, 'end', '', '2');
        }
      } catch (error) {
        sendSse(res, 'error', JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), '1');
      } finally {
        clearInterval(heartbeat);
        streams.delete(streamId);
        res.end();
      }
      return;
    }

    const stopMatch = req.url?.match(/^\/v2\/chat\/s\/stream\/([^/?]+)\/stop$/);
    if (req.method === 'POST' && stopMatch) {
      const streamId = decodeURIComponent(stopMatch[1]);
      const entry = streams.get(streamId);
      if (entry) entry.stopped = true;
      streams.delete(streamId);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('[easyeda-adapter] request failed:', error);
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.keepAliveTimeout = 10 * 60 * 1000;
server.headersTimeout = 10 * 60 * 1000 + 5000;
server.requestTimeout = 0;

server.listen(PORT, HOST, () => {
  console.log(`[easyeda-adapter] Listening on http://${HOST}:${PORT}`);
  console.log(`[easyeda-adapter] Forwarding integrated EasyEDA chat to ${CODEX_BASE}`);
  console.log(`[easyeda-adapter] Stock-aware policy enabled; retries=${MAX_RETRIES}`);
});
