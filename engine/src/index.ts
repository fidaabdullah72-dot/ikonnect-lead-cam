/**
 * CoreNexa engine: WhatsApp sessions, campaign runner, outbox, lead searches,
 * background jobs and automations. Stateless apart from the database — safe
 * to restart at any time.
 */
import { createServer } from 'node:http';
import { config } from './config';
import { db } from './db';
import { log } from './log';
import { every, errMsg, worker } from './util';
import { acquireLease, releaseLease, renewLease } from './lease';
import { SessionManager } from './wa/manager';
import { getMessage, handleUpdates, handleUpsert, onReply } from './messaging/inbound';
import { processOutbox, processReactions, recoverStuckMessages } from './messaging/outbox';
import { CampaignRunner } from './campaigns/runner';
import { ScrapeWorker } from './scraper/worker';
import { JobsWorker } from './jobs/worker';
import { cleanupAutomationQueue, processAutomationQueue, processNoReply, runAutomations } from './automations/runner';
import { listenForSignals } from './signals';
import { browserAvailable } from './scraper/browser';

async function main() {
  log.info({ instance: config.instanceId, version: config.version }, 'CoreNexa engine starting');

  // Health = "process is up". It must NOT wait for the lease: on a Render web
  // service the old instance is only stopped (and releases the lease) once the
  // new one reports healthy. Also the target for keep-alive pings.
  let active = false;
  if (config.port) {
    createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, active, instance: config.instanceId }));
    }).listen(config.port, () => log.info({ port: config.port }, 'health endpoint listening'));
  }

  if (config.role === 'scraper') return runScraperOnly(() => (active = true));

  await acquireLease();
  active = true;

  const manager = new SessionManager({ onMessages: handleUpsert, onUpdates: handleUpdates, getMessage });
  const campaigns = new CampaignRunner(manager);
  const scraper = new ScrapeWorker();
  const jobs = new JobsWorker(manager);
  const browserOk = config.browserScraper ? await browserAvailable() : false;
  if (config.browserScraper && !browserOk) log.warn('Chromium not available: the browser scraper is disabled (run `npm run browsers -w engine`).');

  onReply(async ({ workspaceId, leadId, accountId, text, firstReply }) => {
    await runAutomations({ workspaceId, trigger: 'reply_received', leadId, accountId, text, firstReply });
  });

  await scraper.recover();
  await jobs.recover();
  await campaigns.recoverStuck();
  await recoverStuckMessages();

  const onErr = (what: string) => (e: unknown) => log.error({ err: errMsg(e) }, `${what} failed`);
  // Work loops wake instantly on database signals; the intervals are only a
  // safety net, so an idle engine barely touches the database.
  const reconcile = worker(() => manager.reconcile(), onErr('session reconcile'), { every: 30_000 });
  const outbox = worker(() => processOutbox(manager), onErr('outbox'), { every: 20_000, initialDelay: 2_000 });
  const reactions = worker(() => processReactions(manager), onErr('reactions'), { every: 60_000, initialDelay: 3_000 });
  const scrapes = worker(() => scraper.tick(), onErr('scraper'), { every: 30_000, initialDelay: 3_000 });
  const engineJobs = worker(() => jobs.tick(), onErr('jobs'), { every: 30_000, initialDelay: 3_000 });
  const automationQueue = worker(() => processAutomationQueue(), onErr('automation queue'), { every: 30_000, initialDelay: 5_000 });
  manager.onSettled = () => reconcile.wake();

  const stopSignals = listenForSignals({
    accounts: () => reconcile.wake(),
    connected: () => {
      outbox.wake();
      reactions.wake();
      campaigns.invalidate();
    },
    outbox: () => outbox.wake(),
    reactions: () => reactions.wake(),
    campaigns: () => campaigns.invalidate(),
    scrape: () => scrapes.wake(),
    jobs: () => engineJobs.wake(),
    automation: () => automationQueue.wake(),
  });

  const stops = [
    stopSignals,
    ...[reconcile, outbox, reactions, scrapes, engineJobs, automationQueue].map((w) => w.stop),
    // Cheap when idle: only touches the database when a message is due (cached otherwise).
    every(2_000, () => campaigns.tick(), onErr('campaigns'), 4_000),
    every(60_000, () => manager.watchdog(), onErr('session watchdog'), 30_000),
    every(30 * 60_000, () => manager.refreshLimits(), onErr('limits refresh'), 5 * 60_000),
    every(5 * 60_000, () => campaigns.recoverStuck(), onErr('campaign recovery'), 5 * 60_000),
    every(5 * 60_000, () => recoverStuckMessages(), onErr('message recovery'), 5 * 60_000),
    every(10 * 60_000, () => processNoReply(), onErr('no-reply automations'), 60_000),
    every(60 * 60_000, () => cleanupAutomationQueue(), onErr('automation queue cleanup'), 10 * 60_000),
  ];

  // Lease heartbeat: if another instance ever takes over, stop at once so two
  // engines never drive the same WhatsApp sessions.
  let shuttingDown = false;
  const heartbeat = every(
    Math.floor((config.leaseTtlSeconds * 1000) / 3),
    async () => {
      const stats = manager.stats();
      const ok = await renewLease({
        sessions: stats.sessions,
        connected: stats.connected,
        campaigns: campaigns.activeCount,
        scraping: Boolean(scraper.running),
        browser: browserOk,
      });
      if (!ok && !shuttingDown) {
        log.error('Lost the engine lease to another instance; stopping');
        await shutdown('lease lost', 1);
      }
    },
    onErr('heartbeat'),
  );

  async function shutdown(reason: string, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ reason }, 'shutting down');
    heartbeat();
    for (const stop of stops) stop();
    const timer = setTimeout(() => process.exit(code), 15_000);
    try {
      await manager.shutdown();
      if (code === 0) await releaseLease();
    } catch (e) {
      log.error({ err: errMsg(e) }, 'shutdown error');
    }
    clearTimeout(timer);
    process.exit(code);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log.error({ err: errMsg(e) }, 'unhandled rejection'));
  process.on('uncaughtException', (e) => log.error({ err: errMsg(e) }, 'uncaught exception'));
  log.info('engine running');
}

/**
 * ENGINE_ROLE=scraper: only Google Maps browser searches. No WhatsApp and no
 * lease, so it runs next to the main engine (e.g. on the dashboard's server).
 */
async function runScraperOnly(markActive: () => void) {
  if (!(await browserAvailable())) {
    log.fatal('Chromium is not available — the scraper-only engine needs it');
    process.exit(1);
  }
  markActive();
  const scraper = new ScrapeWorker();
  await scraper.recover();
  const onErr = (what: string) => (e: unknown) => log.error({ err: errMsg(e) }, `${what} failed`);
  const scrapes = worker(() => scraper.tick(), onErr('scraper'), { every: 30_000, initialDelay: 2_000 });
  const noop = () => undefined;
  const stopSignals = listenForSignals({
    scrape: () => scrapes.wake(),
    accounts: noop,
    connected: noop,
    outbox: noop,
    reactions: noop,
    campaigns: noop,
    jobs: noop,
    automation: noop,
  });
  // Lets Settings → Integrations show that Google Maps search is available.
  const beat = () =>
    db.from('engine_status').upsert({ id: 'scraper', version: config.version, heartbeat_at: new Date().toISOString(), info: { browser: true, scraping: Boolean(scraper.running) } });
  const heartbeat = every(30_000, async () => void (await beat()), onErr('scraper heartbeat'));
  // Last line of defence: a search that makes no progress for 20 minutes means something is stuck
  // beyond the per-step time limits. Exit; Docker restarts the engine and the search resumes.
  const watchdog = setInterval(() => {
    if (scraper.running && Date.now() - scraper.lastActivity > 20 * 60_000) {
      log.fatal({ job: scraper.running }, 'lead search stalled — restarting the scraper');
      process.exit(1);
    }
  }, 60_000);

  const shutdown = (reason: string) => {
    log.info({ reason }, 'shutting down');
    stopSignals();
    scrapes.stop();
    heartbeat();
    clearInterval(watchdog);
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log.error({ err: errMsg(e) }, 'unhandled rejection'));
  log.info('scraper-only engine running (Google Maps browser searches)');
}

main().catch((e) => {
  log.fatal({ err: errMsg(e) }, 'engine failed to start');
  process.exit(1);
});
