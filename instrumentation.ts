// Next.js instrumentation - runs on server startup
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

import { APP_BASE_URL, COOLIFY_URL, getConfigWarnings } from './lib/config';
import { getOpenClawDeviceAuthDebugInfo } from './lib/openclaw-ws';

export async function register() {
  // Only run on server
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`jean-ci starting...`);
    console.log(`${'='.repeat(50)}\n`);
    
    try {
      const { initDatabase, cleanupOldEvents, getInterruptedCheckRuns, getRepo, updateCheckRun } = await import('./lib/db');
      
      const startupStartedAt = new Date();
      // Initialize database
      await initDatabase();
      const { queuedReviewRestarts } = await import('./lib/db');
      const { dispatchReviewRestart } = await import('./lib/review-restart');
      const drainRestarts = async () => {
        for (const id of await queuedReviewRestarts()) void dispatchReviewRestart(id).catch(console.error);
      };
      await drainRestarts();
      setInterval(() => drainRestarts().catch(console.error), 30_000);

      const { recoverInterruptedChecks } = await import('./lib/interrupted-check-recovery');
      const { getInstallationOctokit, getCheck, updateCheck } = await import('./lib/github');
      const recover = () => recoverInterruptedChecks({
        listInterruptedChecks: getInterruptedCheckRuns,
        getRepo,
        getInstallationOctokit,
        getGitHubCheck: getCheck,
        completeGitHubCheck: updateCheck,
        markCheckCompleted: updateCheckRun,
        detailsUrl: (id) => `${APP_BASE_URL}/checks/${id}`,
        log: console.log,
      }, startupStartedAt);
      const recovery = await recover();
      if (recovery.recovered || recovery.skipped || recovery.failed) {
        console.log(`Recovered interrupted checks: ${JSON.stringify(recovery)}`);
      }
      
      // Cleanup old events
      await cleanupOldEvents();
      
      // Schedule periodic cleanup (every hour)
      setInterval(() => cleanupOldEvents().catch(console.error), 60 * 60 * 1000);

      // Retry recovery if GitHub or installation authentication was temporarily unavailable at startup.
      setInterval(() => recover().catch(console.error), 5 * 60 * 1000);
      
      // Schedule sync job (every 15 minutes)
      const { runSync } = await import('./lib/sync');
      setInterval(() => runSync().catch(console.error), 15 * 60 * 1000);
      
      console.log('');
      console.log(`📡 Webhook: ${APP_BASE_URL}/api/github/webhook`);
      console.log(`🔑 App ID: ${process.env.GITHUB_APP_ID}`);
      console.log(`👤 Admin: ${process.env.ADMIN_GITHUB_ID || '(anyone)'}`);
      console.log(`🗄️  Database: PostgreSQL ✅`);
      console.log(`🚀 Coolify: ${process.env.COOLIFY_TOKEN ? COOLIFY_URL || '(missing COOLIFY_URL)' : '(not configured)'}`);
      const openClawAuth = await getOpenClawDeviceAuthDebugInfo();
      console.log(`🧠 OpenClaw WS: ${openClawAuth.websocketEnabled ? 'enabled' : 'disabled'}`);
      console.log(`🧠 OpenClaw gateway: ${openClawAuth.gatewayUrl || '(missing OPENCLAW_GATEWAY_URL)'}`);
      console.log(`🧠 OpenClaw device: ${openClawAuth.deviceId}`);
      console.log(`🧠 OpenClaw identity file: ${openClawAuth.identityPath} ${openClawAuth.identityExists ? '(existing)' : '(created on startup)'}`);
      console.log(`🧠 OpenClaw token store: ${openClawAuth.tokenStorePath} ${openClawAuth.tokenStoreExists ? '(present)' : '(missing)'}`);
      console.log(`🧠 OpenClaw shared token: ${openClawAuth.hasSharedToken ? 'present' : 'missing'}`);
      console.log(`🧠 OpenClaw stored device token: ${openClawAuth.hasStoredDeviceToken ? 'present' : 'missing'}`);
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
