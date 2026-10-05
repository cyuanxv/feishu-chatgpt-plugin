import { startDemoServer } from './server.js';

// Read only these non-secret options. Never read .env or ambient credentials in mock mode.
if (process.env.FEISHU_MODE && process.env.FEISHU_MODE !== 'mock') throw new Error('Live Feishu mode is not implemented. This build only runs synthetic fixtures.');
const port = Number(process.env.PORT ?? '3333');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535.');
const app = await startDemoServer({ port });
console.info(`Synthetic read-only MCP demo: ${app.issuer}. No real Feishu connection. Not suitable for public exposure.`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().finally(() => process.exit(0)); });
