// Next.js instrumentation - runs on server startup
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function register() {
  // Only run on server
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initDatabase, cleanupOldEvents } = await import('./lib/db');
    
    console.log(`\n${'='.repeat(50)}`);
    console.log(`jean-ci starting...`);
    console.log(`${'='.repeat(50)}\n`);
    
    // Initialize database
    await initDatabase();
    
    // Cleanup old events
    await cleanupOldEvents();
    
    // Schedule periodic cleanup (every hour)
    setInterval(() => cleanupOldEvents().catch(console.error), 60 * 60 * 1000);
    
    console.log('');
    console.log(`📡 Webhook: https://jean-ci.telegraphic.app/api/github/webhook`);
    console.log(`🔑 App ID: ${process.env.GITHUB_APP_ID}`);
    console.log(`👤 Admin: ${process.env.ADMIN_GITHUB_ID || '(anyone)'}`);
    console.log(`🗄️  Database: PostgreSQL`);
    console.log(`🚀 Coolify: ${process.env.COOLIFY_TOKEN ? process.env.COOLIFY_URL || 'https://apps.telegraphic.app' : '(not configured)'}`);
    console.log('');
    console.log(`${'='.repeat(50)}`);
    console.log(`Status: 🟢 READY`);
    console.log(`${'='.repeat(50)}\n`);
  }
}
