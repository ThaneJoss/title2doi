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

function isSubdomainGatewayError(output) {
  return /\bPOST\s+\/accounts\/[^\s/]+\/workers\/scripts\/title2doi\/subdomain\s*->\s*(?:502|503|504)\b/.test(stripVTControlCharacters(output));
}

export async function deployWithRetry(runAttempt, {
  wait = ms => sleep(ms, undefined, { signal }),
  report = message => console.error(message),
  signal,
  recoverTriggers,
} = {}) {
  let recovering = false;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    signal?.throwIfAborted();
    report(`[title2doi] ${recovering ? '恢复域名配置' : '部署尝试'} ${attempt + 1}/${retryDelays.length + 1}`);
    const result = await (recovering ? recoverTriggers() : runAttempt());
    signal?.throwIfAborted();
    if (result.code === 0 || result.signal) {
      return exitCode(result);
    }
    const uploaded = /\bUploaded title2doi\s*\(/.test(stripVTControlCharacters(result.output));
    if (recoverTriggers && isSubdomainGatewayError(result.output) && (recovering || uploaded)) {
      // The Worker is already uploaded. Resume only trigger configuration;
      // never publish another version in response to a post-upload failure.
      recovering = true;
    } else if (recovering || !isUploadSessionGatewayError(result.output)) {
      return exitCode(result);
    }
    if (attempt === retryDelays.length) {
      report(`[title2doi] Cloudflare ${recovering ? '域名配置' : '上传会话'}仍返回网关错误。已停止重试；请稍后重新部署，持续失败时携带原始日志和 Ray ID 联系 Cloudflare。`);
      return exitCode(result);
    }
    const delay = retryDelays[attempt];
    report(recovering
      ? `[title2doi] Worker 已上传，将在 ${delay / 1000} 秒后通过 wrangler triggers deploy 恢复域名配置。`
      : `[title2doi] Cloudflare 创建上传会话失败，将在 ${delay / 1000} 秒后重试。`);
    await wait(delay);
  }
}

function runWrangler(args, signal) {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('wrangler/package.json');
  const wrangler = resolve(dirname(packagePath), require('wrangler/package.json').bin.wrangler);
  return new Promise((resolveAttempt, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
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
    const args = process.argv.slice(2);
    process.exitCode = await deployWithRetry(
      () => runWrangler(['deploy', '--assets', './dist', ...args], controller.signal),
      {
        signal: controller.signal,
        // Only resume the project's default command. Extra CLI overrides can
        // change name/env/routes, so never discard them and target production.
        recoverTriggers: args.length === 0
          ? () => runWrangler(['triggers', 'deploy'], controller.signal)
          : undefined,
      },
    );
  } catch (error) {
    process.exitCode = cancellationCode ?? 1;
    if (!cancellationCode) console.error(`[title2doi] ${error.message}`);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}
