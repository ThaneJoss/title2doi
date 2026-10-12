import assert from 'node:assert/strict';
import test from 'node:test';
import { deployWithRetry } from '../scripts/deploy-worker.mjs';

const session = '/accounts/example/workers/scripts/title2doi/assets-upload-session';
const failure = (status = 504, code = 1) => ({ code, output: `\u001b[31m[ERROR]\u001b[0m Received a malformed response from the API\n<!DOCTYPE html>\nPOST ${session} -> ${status} Gateway Timeout\nCloudflare Ray ID: example-DFW` });
const quiet = { report() {} };

test('retries the reported HTML 504 once and stops immediately after success', async () => {
  let attempts = 0;
  const waits = [];
  const code = await deployWithRetry(async () => ++attempts === 1 ? failure() : { code: 0, output: 'Deployed title2doi' }, {
    ...quiet, wait: async ms => waits.push(ms),
  });
  assert.equal(code, 0);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [15_000]);
});

test('persistent session gateway errors stop after three attempts and preserve failure status', async () => {
  let attempts = 0;
  const waits = [];
  const code = await deployWithRetry(async () => failure([502, 503, 504][attempts++], 7), {
    ...quiet, wait: async ms => waits.push(ms),
  });
  assert.equal(code, 7);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [15_000, 30_000]);
});

test('configuration, authentication, size, and later deployment failures are never retried', async () => {
  const outputs = [
    failure(400).output, failure(401).output, failure(403).output, failure(413).output,
    'Asset too large', 'Received a malformed response from the API\n<!DOCTYPE html>',
    'POST /accounts/example/workers/scripts/title2doi/deployments -> 504 Gateway Timeout',
    'PUT /accounts/example/workers/scripts/title2doi -> 504 Gateway Timeout',
    `GET ${session} -> 504 Gateway Timeout`,
    'SyntaxError: invalid wrangler.jsonc',
  ];
  for (const output of outputs) {
    let attempts = 0;
    const code = await deployWithRetry(async () => { attempts++; return { code: 2, output }; }, {
      ...quiet, wait: async () => assert.fail('This error must not be retried'),
    });
    assert.equal(code, 2);
    assert.equal(attempts, 1);
  }
});

test('a successful or signalled process is not repeated even if output contains a gateway error', async () => {
  for (const result of [{ ...failure(), code: 0 }, { ...failure(), code: null, signal: 'SIGTERM' }]) {
    let attempts = 0;
    const code = await deployWithRetry(async () => { attempts++; return result; }, {
      ...quiet, wait: async () => assert.fail('Must not retry a completed or cancelled process'),
    });
    assert.equal(code, result.code === 0 ? 0 : 143);
    assert.equal(attempts, 1);
  }
});

test('cancelling the retry wait prevents another deployment attempt', async () => {
  const controller = new AbortController();
  let attempts = 0;
  await assert.rejects(deployWithRetry(async () => { attempts++; return failure(); }, {
    ...quiet, signal: controller.signal, wait: async () => controller.abort(),
  }), { name: 'AbortError' });
  assert.equal(attempts, 1);
});
