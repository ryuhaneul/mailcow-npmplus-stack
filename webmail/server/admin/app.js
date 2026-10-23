import { join } from 'node:path';
import { createQuotaNotificationStore } from './quota-notification-state.js';
import { createQuotaNotificationMailer } from './quota-notification-mail.js';
import { createQuotaNotificationScheduler } from './quota-notification-scheduler.js';
import { createQuotaNotificationsService } from './services/quota-notifications.js';
import quotaNotificationRoutes from './routes/quota-notifications.js';
import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadAdminConfig } from './config.js';
import { installAdminAuth } from './routes/auth.js';
import { createApiKeyStore } from './api-keys.js';
import { createApiKeysService } from './services/api-keys.js';
import apiKeysRoutes from './routes/api-keys.js';
import { createAudit } from './audit.js';
import { createResourceLock } from './lock.js';
import { createHistoryService } from './services/history.js';
import historyRoutes from './routes/history.js';
import { createDockerApi } from './dockerapi.js';
import { createSharesService } from './services/shares.js';
import sharesRoutes from './routes/shares.js';
import { createTeamsService } from './services/teams.js';
import teamsRoutes from './routes/teams.js';
import { createAccountsService } from './services/accounts.js';
import accountsRoutes from './routes/accounts.js';
import { createAliasesService } from './services/aliases.js';
import aliasesRoutes from './routes/aliases.js';
import { createDomainsService } from './services/domains.js';
import domainsRoutes from './routes/domains.js';
import { createSendersService } from './services/senders.js';
import sendersRoutes from './routes/senders.js';
import { createFlowsService } from './services/flows.js';
import flowsRoutes from './routes/flows.js';
import { createFiltersService } from './services/filters.js';
import filtersRoutes from './routes/filters.js';
import { createSyncService } from './services/sync.js';
import syncRoutes from './routes/sync.js';
import { createBatchService } from './services/batch.js';
import batchRoutes from './routes/batch.js';
import { createQuarantineService } from './services/quarantine.js';
import quarantineRoutes from './routes/quarantine.js';
import { createFwdhostsService } from './services/fwdhosts.js';
import fwdhostsRoutes from './routes/fwdhosts.js';
import { createRspamdMapsService } from './services/rspamd-maps.js';
import rspamdMapsRoutes from './routes/rspamd-maps.js';
import { createF2bService } from './services/f2b.js';
import securityRoutes from './routes/security.js';
import { createStatusService } from './services/status.js';
import statusRoutes from './routes/status.js';
import ftsRoutes from './routes/fts.js';
import { createLogArchiveClient } from './log-archive-client.js';
import { createLogsService } from './services/logs.js';
import logsRoutes from './routes/logs.js';
import { createLogoService } from './services/logo.js';
import logoRoutes from './routes/logo.js';
import { createRelayService } from './services/relay.js';
import relayRoutes from './routes/relay.js';
import { createTrustedService } from './services/trusted.js';
import trustedRoutes from './routes/trusted.js';
import { createDoveadm } from './doveadm.js';
import { createFtsState } from './fts-state.js';
import { createFtsMeasure } from './services/fts-measure.js';
import { createFtsNightly } from './services/fts-nightly.js';
import { createFtsScheduler } from './fts-scheduler.js';
import { createAclReader } from './acl-reader.js';
import { createAclFolders } from './acl-folders.js';
import { createCleanupService } from './services/cleanup.js';
import { createQuotaService } from './services/quota.js';
import cleanupRoutes from './routes/cleanup.js';
import { logOptions } from '../log.js';
import { installErrors, errorBody } from '../errors.js';
import { installHeaders, installClientIp } from '../security/headers.js';

export const adminCsp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";

export async function createAdminApp({ config = loadAdminConfig(), staticDir = fileURLToPath(new URL('../../web/dist-admin/', import.meta.url)), logger = logOptions(config.logLevel), auth = {}, audit: auditOptions = {}, dockerapi, tlsExpiry, doveadm } = {}) {
  if (logger !== false) {
    const base = logOptions(config.logLevel);
    logger = { ...base, ...logger, redact: { ...base.redact, ...logger?.redact,
      paths: [...new Set([...base.redact.paths, ...(logger?.redact?.paths ?? []),
        'req.headers.cookie', 'req.headers["x-mailadmin-csrf"]', 'req.body',
        'req.headers["x-mailadmin-api-key"]', 'mailcowApiKey', 'MAILCOW_API_KEY', '*.mailcowApiKey', '*.MAILCOW_API_KEY',
        'logArchiveKey', 'LOG_ARCHIVE_KEY', '*.logArchiveKey', '*.LOG_ARCHIVE_KEY', 'req.headers["x-log-archive-key"]',
        '*.token', '*.digest', '*.password', '*.code', '*.dataBase64', '*.script'])] } };
  }
  const app = Fastify({ logger, trustProxy: config.trustProxy, bodyLimit: 64 * 1024, logController: new LogController({ disableRequestLogging: true }) });
  installErrors(app);
  installHeaders(app);
  installClientIp(app);
  app.addHook('onSend', async (request, reply, payload) => {
    let normalizedPath = '';
    try { const url = new URL(request.url, 'http://localhost'); url.pathname = decodeURIComponent(url.pathname); normalizedPath = url.pathname; } catch {}
    reply.header('content-security-policy', normalizedPath.startsWith('/starflow/') ? adminCsp.replace("frame-ancestors 'none'", "frame-ancestors 'self'") : adminCsp);
    const pathname = request.url.split('?')[0];
    if (pathname === '/api' || pathname.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });
  const apiKeys = createApiKeyStore({ directory: config.apiKeyDir, now: auth.now });
  app.decorate('apiKeys', apiKeys);
  await installAdminAuth(app, { ...auth, config, apiKeys });
  const audit = createAudit({ ...auditOptions, dir: config.auditDir, logger: app.log });
  const adminLock = createResourceLock();
  const history = createHistoryService({ audit, lock: adminLock });
  app.decorate('audit', audit);
  app.decorate('adminLock', adminLock);
  app.decorate('adminHistory', history);
  const apiKeysService = createApiKeysService({ store: apiKeys, config, audit, lock: adminLock });
  await app.register(apiKeysRoutes, { service: apiKeysService });
  await app.register(historyRoutes, { service: history });
  dockerapi ??= createDockerApi({ config });
  app.decorate('dockerapi', dockerapi);
  doveadm ??= createDoveadm({ config });
  const ftsConfig = config.ftsNightly ?? { enabled: false, start: '03:00', end: '06:00', stateDir: '/data/fts-nightly' };
  const ftsState = createFtsState({ dir: ftsConfig.stateDir });
  app.decorate('ftsState', ftsState);
  const ftsNightly = createFtsNightly({ state: ftsState, measure: createFtsMeasure({ doveadm }), doveadm, audit, history, logger: app.log });
  const ftsScheduler = createFtsScheduler({ config: ftsConfig, nightly: ftsNightly, logger: app.log });
  app.addHook('onReady', async () => { await ftsScheduler.start(); });
  app.addHook('preClose', async () => { ftsScheduler.stop(); });
  const aclFolders = createAclFolders({ doveadm, dockerapi, config });
  const aclReader = createAclReader({ doveadm, dockerapi, config });
  const sharesDockerapi = { ...dockerapi, getAcl: aclReader.getAcl };
  const shares = createSharesService({ mailcow: app.mailcow, dockerapi: sharesDockerapi, aclFolders, config, audit, lock: adminLock, history });
  app.decorate('shares', shares);
  await app.register(sharesRoutes, { service: shares });
  const teams = createTeamsService({ mailcow: app.mailcow, audit, lock: adminLock, history, auditDir: config.auditDir });
  app.decorate('teams', teams);
  await app.register(teamsRoutes, { service: teams });
  const accounts = createAccountsService({ mailcow: app.mailcow, dockerapi: sharesDockerapi, aclFolders, audit, lock: adminLock, history, teams });
  app.decorate('accounts', accounts);
  await app.register(accountsRoutes, { service: accounts });
  const quotaNotifications = createQuotaNotificationsService({
    store: createQuotaNotificationStore({ dir: config.quotaNotificationDir ?? (config.auditDir ? join(config.auditDir, 'quota-notifications') : '/data/quota-notifications') }),
    mailcow: app.mailcow, config, audit, lock: adminLock, history,
    send: createQuotaNotificationMailer({ config }),
  });
  const quotaNotificationScheduler = createQuotaNotificationScheduler({ service: quotaNotifications, logger: app.log });
  app.addHook('onReady', async () => quotaNotificationScheduler.start());
  app.addHook('preClose', async () => quotaNotificationScheduler.stop());
  await app.register(quotaNotificationRoutes, { service: quotaNotifications });

  const aliases = createAliasesService({ mailcow: app.mailcow, audit, lock: adminLock, history });
  app.decorate('aliases', aliases);
  await app.register(aliasesRoutes, { service: aliases });
  const domains = createDomainsService({ mailcow: app.mailcow, audit, lock: adminLock, history });
  app.decorate('domains', domains);
  await app.register(domainsRoutes, { service: domains });
  const senders = createSendersService({ mailcow: app.mailcow, audit, lock: adminLock, history });
  app.decorate('senders', senders);
  await app.register(sendersRoutes, { service: senders });
  const flows = createFlowsService({ mailcow: app.mailcow, teams, aliases, senders, audit, lock: adminLock });
  app.decorate('flows', flows);
  await app.register(flowsRoutes, { service: flows });
  const filters = createFiltersService({ mailcow: app.mailcow, dockerapi, audit, lock: adminLock, history, auditDir: config.auditDir });
  app.decorate('filters', filters);
  await app.register(filtersRoutes, { service: filters });
  const sync = createSyncService({ mailcow: app.mailcow, audit, lock: adminLock, history });
  app.decorate('sync', sync);
  await app.register(syncRoutes, { service: sync });
  const batch = createBatchService({ mailcow: app.mailcow, accounts, domains, teams, aliases, audit, lock: adminLock });
  app.decorate('batch', batch);
  await app.register(batchRoutes, { service: batch });
  const quarantine = createQuarantineService({ mailcow: app.mailcow, audit, lock: adminLock });
  app.decorate('quarantine', quarantine);
  await app.register(quarantineRoutes, { service: quarantine });
  const fwdhosts = createFwdhostsService({ mailcow: app.mailcow, audit, lock: adminLock, history });
  app.decorate('fwdhosts', fwdhosts);
  await app.register(fwdhostsRoutes, { service: fwdhosts });
  const rspamdMaps = createRspamdMapsService({ mailcow: app.mailcow, audit, lock: adminLock, history, mapDir: config.rspamdMapDir });
  app.decorate('rspamdMaps', rspamdMaps);
  await app.register(rspamdMapsRoutes, { service: rspamdMaps });
  const f2b = createF2bService({ mailcow: app.mailcow, audit, lock: adminLock, history });
  app.decorate('f2b', f2b);
  await app.register(securityRoutes, { service: f2b });
  const status = createStatusService({ mailcow: app.mailcow, config, tlsExpiry });
  app.decorate('status', status);
  await app.register(statusRoutes, { service: status });
  await app.register(ftsRoutes, { state: ftsState, config });
  const logs = createLogsService({ mailcow: app.mailcow, config, logArchive: createLogArchiveClient({ config, logger: app.log }) });
  app.decorate('logs', logs);
  await app.register(logsRoutes, { service: logs });
  const logo = createLogoService({ dir: config.logoDir, audit, lock: adminLock, history, logger: app.log });
  app.decorate('logo', logo);
  await app.register(logoRoutes, { service: logo });
  const relay = createRelayService({ config, mailcow: app.mailcow, dockerapi, audit, lock: adminLock, logs, history });
  app.decorate('relay', relay);
  await app.register(relayRoutes, { service: relay });
  if (config.trustedSenderFile) {
    const trusted = createTrustedService({ config, mailcow: app.mailcow, audit, lock: adminLock, history });
    app.decorate('trusted', trusted);
    await app.register(trustedRoutes, { service: trusted });
  }
  const quota = createQuotaService({ doveadm, audit, lock: adminLock });
  const cleanup = createCleanupService({ mailcow: app.mailcow, doveadm, quota, audit, lock: adminLock });
  await app.register(cleanupRoutes, { cleanup, quota, enabled: Boolean(config.doveadmUrl && config.doveadmKey) });
  app.get('/healthz', async () => ({ ok: true }));
  const root = resolve(staticDir);
  const hasStatic = existsSync(root) && statSync(root).isDirectory();
  if (hasStatic) await app.register(fastifyStatic, { root, wildcard: false, index: ['admin.html'] });
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0];
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    if (hasStatic && !isApi && ['GET', 'HEAD'].includes(request.method) && existsSync(resolve(root, 'admin.html'))) {
      return reply.sendFile('admin.html');
    }
    return reply.code(404).send(errorBody('NOT_FOUND', '요청한 경로를 찾을 수 없어요.'));
  });
  return app;
}
