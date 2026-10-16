import { resolve } from 'node:path';
import { createLedgerServer } from './backend.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必須是 1–65535。');
const server = createLedgerServer({
  dataDirectory: resolve(process.env.LEDGER_DATA_DIR || '.ledger-data'),
  origin: process.env.LEDGER_ORIGIN || process.env.RENDER_EXTERNAL_URL || '',
  production: process.env.NODE_ENV === 'production',
});
server.listen(port, process.env.LEDGER_HOST || '0.0.0.0', () => console.log(`小日子記帳已啟動，連接埠 ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10000).unref();
});
