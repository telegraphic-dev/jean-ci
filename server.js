import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { initDatabase, cleanupOldEvents } from './lib/db.ts';

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function start() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`jean-ci v0.13.0 starting...`);
  console.log(`${'='.repeat(50)}\n`);
  
  // Initialize database
  await initDatabase();
  
  // Cleanup old events
  await cleanupOldEvents();
  
  // Schedule periodic cleanup (every hour)
  setInterval(() => cleanupOldEvents().catch(console.error), 60 * 60 * 1000);
  
  await app.prepare();
  
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });

  server.listen(port, () => {
    console.log('');
    console.log(`📡 Webhook: https://jean-ci.telegraphic.app/api/github/webhook`);
    console.log(`🔧 Port: ${port}`);
    console.log(`🔑 App ID: ${process.env.GITHUB_APP_ID}`);
    console.log(`👤 Admin: ${process.env.ADMIN_GITHUB_ID || '(anyone)'}`);
    console.log(`🗄️  Database: PostgreSQL`);
    console.log(`🚀 Coolify: ${process.env.COOLIFY_TOKEN ? process.env.COOLIFY_URL || 'https://apps.telegraphic.app' : '(not configured)'}`);
    console.log('');
    console.log(`${'='.repeat(50)}`);
    console.log(`Status: 🟢 READY`);
    console.log(`${'='.repeat(50)}\n`);
  });
}

start().catch(console.error);
