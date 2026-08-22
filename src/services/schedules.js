'use strict';

const { get } = require('./context');
const { existingProjectCwds, displayPathName } = require('../routes');

const json = (...args) => get().json(...args);
const readBody = (...args) => get().readBody(...args);
const isAuthorized = (req) => get().isAuthorized(req);
const scheduler = () => get().scheduler;
const listWorkspaceThreads = (...args) => get().listWorkspaceThreads(...args);

async function handleSchedules(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const workspace = await listWorkspaceThreads(160);
  const projects = existingProjectCwds(workspace.threads).map(cwd => ({ cwd, name: displayPathName(cwd) }));
  if (req.method === 'GET') {
    return json(res, 200, { ok: true, schedules: scheduler().getTasks(), projects });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const action = String(payload.action || '').trim();
  const id = String(payload.id || '').trim();
  try {
    if (action === 'create') {
      const task = scheduler().createTask(payload);
      return json(res, 200, { ok: true, schedule: task, schedules: scheduler().getTasks(), projects, message: '已创建计划。' });
    }
    if (action === 'update') {
      const task = scheduler().updateTask(id, payload);
      return json(res, 200, { ok: true, schedule: task, schedules: scheduler().getTasks(), projects, message: '已更新计划。' });
    }
    if (action === 'toggle') {
      const enabled = payload.enabled === true;
      const task = scheduler().toggleTask(id, enabled);
      return json(res, 200, { ok: true, schedule: task, schedules: scheduler().getTasks(), projects, message: enabled ? '已启用计划。' : '已暂停计划。' });
    }
    if (action === 'delete') {
      scheduler().deleteTask(id);
      return json(res, 200, { ok: true, schedules: scheduler().getTasks(), projects, message: '已删除计划。' });
    }
    if (action === 'run') {
      await scheduler().runTask(id, { force: true });
      return json(res, 200, { ok: true, schedules: scheduler().getTasks(), projects, message: '已提交本次计划。' });
    }
    return json(res, 400, { ok: false, code: 'BAD_SCHEDULE_ACTION', message: '不支持的计划操作。' });
  } catch (error) {
    return json(res, error?.status || 500, {
      ok: false,
      code: error?.code || 'SCHEDULE_FAILED',
      message: error?.message || '计划操作失败。',
    });
  }
}

function scheduledTaskSummary() {
  return scheduler().getTasks();
}

function startScheduledTaskRunner() {
  scheduler().start();
}

function stopScheduledTaskRunner() {
  scheduler().stop();
}

module.exports = {
  handleSchedules,
  scheduledTaskSummary,
  startScheduledTaskRunner,
  stopScheduledTaskRunner,
};
