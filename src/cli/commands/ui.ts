import { platform } from 'node:os';
import { resolveAppPaths } from '../../config/app-paths';
import { isAlive } from '../../runtime/registry';
import { spawnProcess } from '../../platform/spawn';
import { readUiSidecar } from '../../ui/sidecar';
import { FEATURE_OFF_REPLY, featureEnabled } from '../../config/profile-schema';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';

export interface RunUiOptions {
  /** Accepted for compatibility; the console is a single machine-wide process. */
  profile?: string;
  /** Print the URL instead of launching a browser. */
  print?: boolean;
}

/**
 * Open the running supervisor's management console in the browser. The console
 * is hosted by the single supervisor process (one per machine) and advertises
 * its URL + token in a host-level sidecar. If no supervisor is running, guide
 * the user to start one.
 */
export async function runUi(opts: RunUiOptions = {}): Promise<void> {
  const rootDir = process.env.LARK_CHANNEL_HOME;
  const appPaths = resolveAppPaths({ rootDir });

  // f03p-slim-#6: the profile switched the web console off.
  if (!(await webConsoleEnabled(appPaths, opts.profile))) {
    console.error(`${FEATURE_OFF_REPLY}：Web 控制台（profile features.webConsole=false）`);
    process.exitCode = 1;
    return;
  }

  const sidecar = await readUiSidecar(appPaths.hostUiFile);
  if (sidecar && isAlive(sidecar.pid)) {
    if (opts.print) {
      console.log(sidecar.url);
      return;
    }
    console.log(`打开控制台：${sidecar.url}`);
    openBrowser(sidecar.url);
    return;
  }

  console.error(
    [
      '未检测到运行中的控制面。',
      '',
      '控制台需要 supervisor 模式（--web-ui）：',
      '  aiduCAT run --web-ui        # 前台运行 supervisor + 控制台',
      '  aiduCAT start --web-ui      # 作为后台服务运行 supervisor + 控制台',
      '',
      '（不带 --web-ui 的 run/start 是单 profile 无界面运行，适合无浏览器环境。）',
      '',
      '启动后再次运行 `aiduCAT ui` 打开控制台。',
    ].join('\n'),
  );
  process.exitCode = 1;
}

async function webConsoleEnabled(
  appPaths: { configFile: string; rootDir: string },
  profile: string | undefined,
): Promise<boolean> {
  const root = await loadRootConfig(appPaths.configFile).catch(() => undefined);
  if (!root) return true;
  const name = profile ?? (await readActiveProfile(appPaths.rootDir).catch(() => undefined)) ?? root.activeProfile;
  return featureEnabled(root.profiles[name], 'webConsole');
}

/** Best-effort cross-platform "open this URL in the default browser". */
function openBrowser(url: string): void {
  const os = platform();
  const [cmd, args] =
    os === 'darwin'
      ? ['open', [url]]
      : os === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawnProcess(cmd as string, args as string[], { stdio: 'ignore' });
    child.on('error', () => {
      console.log(`若浏览器未自动打开，请手动访问上面的地址。`);
    });
    child.unref?.();
  } catch {
    console.log('无法自动打开浏览器，请手动访问上面的地址。');
  }
}
