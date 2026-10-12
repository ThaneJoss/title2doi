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

const subdomain = '/accounts/example/workers/scripts/title2doi/subdomain';
const subdomainFailure = (status = 504, { uploaded = true, code = 1 } = {}) => ({
  code,
  output: `${uploaded ? '\u001b[32mUploaded title2doi (10.25 sec)\u001b[0m\n' : ''}\u001b[31m[ERROR]\u001b[0m Received a malformed response from the API\n<!DOCTYPE html>\nPOST ${subdomain} -> ${status} Gateway Timeout\nCloudflare Ray ID: example-DFW`,
});

test('the reported post-upload subdomain timeout recovers triggers without uploading again', async () => {
  let uploads = 0;
  let recoveries = 0;
  const waits = [];
  const code = await deployWithRetry(async () => {
    uploads++;
    return subdomainFailure();
  }, {
    ...quiet,
    recoverTriggers: async () => {
      recoveries++;
      return { code: 0, output: 'Deployed title2doi triggers\n  title2doi.thanejoss.com (custom domain)' };
    },
    wait: async ms => waits.push(ms),
  });
  assert.equal(code, 0);
  assert.equal(uploads, 1);
  assert.equal(recoveries, 1);
  assert.deepEqual(waits, [15_000]);
});

test('persistent subdomain gateway errors share the three-attempt cap and never reupload', async () => {
  let uploads = 0;
  let recoveries = 0;
  const waits = [];
  const code = await deployWithRetry(async () => {
    uploads++;
    return subdomainFailure(502);
  }, {
    ...quiet,
    recoverTriggers: async () => subdomainFailure([503, 504][recoveries++], { uploaded: false, code: 7 }),
    wait: async ms => waits.push(ms),
  });
  assert.equal(code, 7);
  assert.equal(uploads, 1);
  assert.equal(recoveries, 2);
  assert.deepEqual(waits, [15_000, 30_000]);
});

test('a trigger recovery permission error stops immediately with its original exit code', async () => {
  let uploads = 0;
  let recoveries = 0;
  const waits = [];
  const code = await deployWithRetry(async () => {
    uploads++;
    return subdomainFailure();
  }, {
    ...quiet,
    recoverTriggers: async () => {
      recoveries++;
      return subdomainFailure(403, { uploaded: false, code: 9 });
    },
    wait: async ms => waits.push(ms),
  });
  assert.equal(code, 9);
  assert.equal(uploads, 1);
  assert.equal(recoveries, 1);
  assert.deepEqual(waits, [15_000]);
});

test('subdomain recovery requires both a completed upload marker and a recovery callback', async () => {
  for (const [uploaded, callback] of [[false, true], [true, false], [false, false]]) {
    let uploads = 0;
    const options = { ...quiet, wait: async () => assert.fail('Unconfirmed upload must not be retried') };
    if (callback) options.recoverTriggers = async () => assert.fail('Recovery requires a completed upload');
    const code = await deployWithRetry(async () => {
      uploads++;
      return subdomainFailure(504, { uploaded, code: 6 });
    }, options);
    assert.equal(code, 6);
    assert.equal(uploads, 1);
  }
});

test('an upload-session failure followed by a subdomain timeout leaves one trigger recovery attempt', async () => {
  let uploads = 0;
  let recoveries = 0;
  const waits = [];
  const code = await deployWithRetry(async () => ++uploads === 1 ? failure() : subdomainFailure(), {
    ...quiet,
    recoverTriggers: async () => {
      recoveries++;
      return subdomainFailure(504, { uploaded: false, code: 8 });
    },
    wait: async ms => waits.push(ms),
  });
  assert.equal(code, 8);
  assert.equal(uploads, 2);
  assert.equal(recoveries, 1);
  assert.deepEqual(waits, [15_000, 30_000]);
});

test('a different recovery failure never falls back to a full deployment', async () => {
  let uploads = 0;
  let recoveries = 0;
  const waits = [];
  const code = await deployWithRetry(async () => {
    uploads++;
    return subdomainFailure();
  }, {
    ...quiet,
    recoverTriggers: async () => {
      recoveries++;
      return failure(504, 5);
    },
    wait: async ms => waits.push(ms),
  });
  assert.equal(code, 5);
  assert.equal(uploads, 1);
  assert.equal(recoveries, 1);
  assert.deepEqual(waits, [15_000]);
});

test('cancelling after upload prevents trigger recovery and preserves cancellation', async () => {
  const controller = new AbortController();
  let uploads = 0;
  let recoveries = 0;
  await assert.rejects(deployWithRetry(async () => {
    uploads++;
    return subdomainFailure();
  }, {
    ...quiet,
    recoverTriggers: async () => { recoveries++; return { code: 0, output: '' }; },
    signal: controller.signal,
    wait: async () => controller.abort(),
  }), { name: 'AbortError' });
  assert.equal(uploads, 1);
  assert.equal(recoveries, 0);
});
