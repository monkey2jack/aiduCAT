/**
 * f0.4-lockfix: retry policy for short file locks that several aiduCAT
 * processes share (the registry, the shared config.json). Two profiles started
 * at the same moment (systemd, boot) must wait for each other, not exit with
 * `Lock file is already being held`.
 *
 * ~35s of backoff with jitter: longer than the 30s `stale` window, so a lock
 * left behind by a killed process is taken over instead of failing.
 */
export const SHARED_LOCK_STALE_MS = 30_000;
export const SHARED_LOCK_UPDATE_MS = 10_000;
export const SHARED_LOCK_RETRIES = {
  retries: 45,
  factor: 1.5,
  minTimeout: 20,
  maxTimeout: 1_000,
  randomize: true,
} as const;
