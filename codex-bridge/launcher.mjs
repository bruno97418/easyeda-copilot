process.env.EASYEDA_CODEX_PORT ||= '8791';
process.env.EASYEDA_ADAPTER_PORT ||= '8790';
process.env.EASYEDA_CODEX_INTERNAL_BASE ||= 'http://127.0.0.1:8791/v1';

await import('./server.mjs');
await import('./easyeda-adapter.mjs');
