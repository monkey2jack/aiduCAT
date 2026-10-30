/**
 * f031-sec-M2: the local console URL embeds its access token
 * (`http://127.0.0.1:port/?token=…`). Anything that leaves the terminal —
 * Feishu cards, daemon stdout (journald / launchd log files) — gets the
 * token-free form. Only `aiduCAT ui` (run locally by the owner) prints it whole.
 */
export function maskConsoleUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return url.replace(/([?&]token=)[^&#\s]*/gi, '$1***');
  }
}
