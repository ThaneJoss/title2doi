import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const retryDelays = [15_000, 30_000];
const exitCode = result => result.code ?? (128 + (constants.signals[result.signal] ?? 1));

// Retry only a gateway failure while creating the upload session. At this
// stage Wrangler has not published a new Worker version or changed its routes.
export function isUploadSessionGatewayError(output) {
  return /\bPOST\s+\/accounts\/[^\s/]+\/workers\/scripts\/[^\s/]+\/assets-upload-session\s*->\s*(?:502|503|504)\b/.test(stripVTControlCharacters(output));
}

export async function deployWithRetry(runAttempt, {
  wait = ms => sleep(ms, undefined, { signal }),
  report = message => console.error(message),
  signal,
} = {}) {
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    signal?.throwIfAborted();
    report(`[title2doi] 部署尝试 ${attempt + 1}/${retryDelays.length + 1}`);
    const result = await runAttempt();
    signal?.throwIfAborted();
    if (result.code === 0 || result.signal || !isUploadSessionGatewayError(result.output)) {
      return exitCode(result);
    }
    if (attempt === retryDelays.length) {
      report('[title2doi] Cloudflare 上传会话仍返回网关错误。已停止重试；请稍后重新部署，持续失败时携带原始日志和 Ray ID 联系 Cloudflare。');
      return exitCode(result);
    }
    const delay = retryDelays[attempt];
    report(`[title2doi] Cloudflare 创建上传会话失败，将在 ${delay / 1000} 秒后重试。`);
    await wait(delay);
  }
}

function runWrangler(args, signal) {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('wrangler/package.json');
  const wrangler = resolve(dirname(packagePath), require('wrangler/package.json').bin.wrangler);
  return new Promise((resolveAttempt, reject) => {
    const child = spawn(process.execPath, [wrangler, 'deploy', '--assets', './dist', ...args], {
      cwd: root,
      stdio: ['inherit', 'pipe', 'pipe'],
      signal,
    });
    let output = '';
    const forward = stream => chunk => {
      stream.write(chunk);
      // Keep only the recent error output in memory; do not create a second log.
      output = (output + chunk.toString()).slice(-64 * 1024);
    };
    child.stdout.on('data', forward(process.stdout));
    child.stderr.on('data', forward(process.stderr));
    child.once('error', reject);
    child.once('close', (code, childSignal) => resolveAttempt({ code, signal: childSignal, output }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  let cancellationCode;
  const cancel = signal => {
    cancellationCode = 128 + constants.signals[signal];
    controller.abort();
  };
  const interrupt = () => cancel('SIGINT');
  const terminate = () => cancel('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    process.exitCode = await deployWithRetry(
      () => runWrangler(process.argv.slice(2), controller.signal),
      { signal: controller.signal },
    );
  } catch (error) {
    process.exitCode = cancellationCode ?? 1;
    if (!cancellationCode) console.error(`[title2doi] ${error.message}`);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}
