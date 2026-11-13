'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Scheduler, normalizeScheduledTask } = require('../src/scheduler');

function fixture(overrides = {}, sendTurn = async () => { throw new Error('offline'); }) {
  let state = { scheduledTasks: [normalizeScheduledTask({
    id: 'retry-task-1', prompt: 'test', intervalMinutes: 60, retryStrategy: 'fixed',
    nextRunAt: new Date(0).toISOString(), ...overrides,
  })] };
  return new Scheduler({
    store: { readState: () => structuredClone(state), writeState: next => { state = structuredClone(next); } },
    codexAppServer: { sendTurn }, logger: { warn() {} },
  });
}

test('fixed and exponential retries stop at the configured budget', async () => {
  for (const [retryStrategy, retries, initialDelay] of [['fixed', 3, 60000], ['exponential', 5, 30000]]) {
    const scheduler = fixture({ retryStrategy });
    for (let attempt = 0; attempt <= retries; attempt++) {
      const before = Date.now();
      const result = await scheduler.runTask('retry-task-1', { force: true });
      if (attempt < retries) {
        assert.equal(result.retryCount, attempt + 1);
        const expected = initialDelay * (retryStrategy === 'exponential' ? 2 ** attempt : 1);
        const delay = Date.parse(result.nextRunAt) - before;
        assert.ok(delay >= expected && delay < expected + 1000);
      } else {
        assert.equal(result.retryCount, 0);
        assert.match(result.lastMessage, new RegExp(`重试 ${retries} 次后仍失败`));
        assert.ok(Date.parse(result.nextRunAt) >= before + 3600000);
      }
    }
  }
});

test('deleting or disabling an in-flight failed schedule does not resurrect or retry it', async () => {
  for (const action of ['delete', 'disable']) {
    let rejectSend;
    const scheduler = fixture({}, () => new Promise((_, reject) => { rejectSend = reject; }));
    const run = scheduler.runTask('retry-task-1', { force: true });
    if (action === 'delete') scheduler.deleteTask('retry-task-1');
    else scheduler.toggleTask('retry-task-1', false);
    rejectSend(new Error('connection lost'));
    assert.equal(await run, null);
    assert.equal(scheduler._runningTasks.size, 0);
    assert.equal(scheduler.getTasks().filter(task => task.enabled).length, 0);
  }
});

test('enabling cron uses the next cron occurrence in its timezone', () => {
  const scheduler = fixture({ enabled: false, cronExpression: '17 9 * * *', timezone: 'Asia/Shanghai' });
  const task = scheduler.toggleTask('retry-task-1', true);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(task.nextRunAt));
  assert.equal(time, '09:17');
  assert.ok(Date.parse(task.nextRunAt) > Date.now());
});
