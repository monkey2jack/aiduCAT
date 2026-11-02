import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * f0.4 之后的修复 (bwrap): runs not started by the owner set
 * CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1; on Linux, Claude Code (2.1.3xx) then
 * refuses to start at all without bubblewrap ("bubblewrap is required for
 * subprocess env scrubbing and isolation"). Owner runs are unaffected, so the
 * gap only shows when someone else talks to the bot — say so at startup.
 *
 * Returns the warning hint when bwrap is missing on Linux, else undefined.
 */
export function bwrapMissingHint(
  platform: NodeJS.Platform = process.platform,
  pathEnv: string | undefined = process.env.PATH,
): string | undefined {
  if (platform !== 'linux') return undefined;
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, 'bwrap'), constants.X_OK);
      return undefined;
    } catch {
      /* keep looking */
    }
  }
  return 'bwrap not found on PATH: runs started by anyone but the owner will fail to start Claude Code. Install it: sudo apt-get install -y bubblewrap socat';
}
