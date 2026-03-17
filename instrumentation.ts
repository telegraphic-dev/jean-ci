// Next.js instrumentation - runs on server startup
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

import { APP_BASE_URL, COOLIFY_URL, getConfigWarnings } from './lib/config';

export async function register() {
  // Only run on server
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`jean-ci starting...`);
    console.log(`${'='.repeat(50)}\n`);
    
    try {
      const { initDatabase, cleanupOldEvents } = await import('./lib/db');
      
      // Initialize database
      await initDatabase();
      
      // Cleanup old events
      await cleanupOldEvents();
      
      // Schedule periodic cleanup (every hour)
      setInterval(() => cleanupOldEvents().catch(console.error), 60 * 60 * 1000);
      
      // Schedule sync job (every 15 minutes)
      const { runSync } = await import('./lib/sync');
      setInterval(() => runSync().catch(console.error), 15 * 60 * 1000);
      
      console.log('');
      console.log(`📡 Webhook: ${APP_BASE_URL}/api/github/webhook`);
      console.log(`🔑 App ID: ${process.env.GITHUB_APP_ID}`);
      console.log(`👤 Admin: ${process.env.ADMIN_GITHUB_ID || '(anyone)'}`);
      console.log(`🗄️  Database: PostgreSQL ✅`);
      console.log(`🚀 Coolify: ${process.env.COOLIFY_TOKEN ? COOLIFY_URL || '(missing COOLIFY_URL)' : '(not configured)'}`);
      for (const warning of getConfigWarnings()) {
        console.log(`⚠️  Config: ${warning}`);
      }
      console.log('');
      console.log(`${'='.repeat(50)}`);
      console.log(`Status: 🟢 READY`);
      console.log(`${'='.repeat(50)}\n`);
    } catch (error) {
      console.error('⚠️  Failed to initialize database:', error);
      console.log('');
      console.log(`${'='.repeat(50)}`);
      console.log(`Status: 🟡 DEGRADED (DB unavailable)`);
      console.log(`${'='.repeat(50)}\n`);
      // Don't crash - let the app start anyway
      // API routes will fail with better error messages
    }
  }
}
