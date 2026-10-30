import { describe, expect, it, vi } from 'vitest';
import { createProcessErrorHandlers } from '../../../src/core/process-errors.js';

describe('process error handlers', () => {
  it('f031-stab-#6-287 records an unhandled rejection without exiting', () => {
    const logFailure = vi.fn();
    const reportError = vi.fn();
    const exit = vi.fn();
    const handlers = createProcessErrorHandlers({ logFailure, reportError, exit });
    const reason = new Error('async failure');

    handlers.unhandledRejection(reason);

    expect(logFailure).toHaveBeenCalledWith(reason, 'unhandledRejection');
    expect(reportError).toHaveBeenCalledWith(reason, 'unhandledRejection');
    expect(exit).not.toHaveBeenCalled();
  });

  it('f031-stab-#6-287 records an uncaught exception once and exits once even if reporting throws', () => {
    const logFailure = vi.fn(() => {
      throw Object.assign(new Error('write EIO'), { code: 'EIO' });
    });
    const reportError = vi.fn(() => {
      throw new Error('telemetry failed');
    });
    const exit = vi.fn();
    const handlers = createProcessErrorHandlers({ logFailure, reportError, exit });
    const fatal = new Error('fatal');

    expect(() => handlers.uncaughtException(fatal)).not.toThrow();
    expect(() => handlers.uncaughtException(new Error('recursive'))).not.toThrow();

    expect(logFailure).toHaveBeenCalledTimes(1);
    expect(logFailure).toHaveBeenCalledWith(fatal, 'uncaughtException');
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('f031-stab-#6-287 daily log cap default', () => {
  it('f031-stab-#6-287 a fresh logger caps each daily file at 128MB', async () => {
    vi.resetModules();
    const prev = process.env.LARK_CHANNEL_LOG_MAX_BYTES;
    delete process.env.LARK_CHANNEL_LOG_MAX_BYTES;
    try {
      const fresh = await import('../../../src/core/logger.js');
      expect(fresh.getLoggerConfig().maxFileBytes).toBe(128 * 1024 * 1024);
    } finally {
      if (prev !== undefined) process.env.LARK_CHANNEL_LOG_MAX_BYTES = prev;
    }
  });
});
