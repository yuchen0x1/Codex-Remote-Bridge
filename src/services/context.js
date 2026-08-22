'use strict';

const ctx = {
  json: null,
  readBody: null,
  isAuthorized: null,
  security: null,
  store: null,
  logger: null,
  parser: null,
  persistentQueue: null,
  scheduler: null,
  sessionManager: null,
  certManager: null,
  cdpWsHub: null,
  codexAppServer: null,
  platform: null,
  statusTailReader: null,
  recentSendRequests: null,
  lastCodexThreadActivation: null,
  codexSessionFilesCache: null,
  threadIndexCache: null,
  sessionMetaCache: null,
  firstUserMessageCache: null,
  runtimeSummaryCache: null,
  codexThreadListCache: null,
  modelCatalogCache: null,
  keepAwakeProcess: null,
  keepAwakeStartedAt: null,
  scheduledTaskTimer: null,
  scheduledTaskRuns: null,
  pullRequestCache: null,
  screenshotCache: null,
  screenshotCacheBusy: null,
};

function configure(overrides) {
  Object.assign(ctx, overrides);
}

function get() {
  return ctx;
}

module.exports = { ctx, configure, get };
