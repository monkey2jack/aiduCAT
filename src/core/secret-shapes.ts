/**
 * f031-sec-#4 / #10: mask strings that look like credentials, wherever they
 * come from (agent answer, tool output, log line). Shape-based, so it also
 * catches keys the bridge has never heard of. Kept conservative: values must
 * be long enough to be a real secret so ordinary prose survives.
 */
const NAME = '[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|credential)[A-Za-z0-9_.-]*';

const RULES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
  [/\b(Bearer\s+)(?!\[REDACTED)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  // "apiKey": "…"  /  \"app_secret\":\"…\"
  [new RegExp(`((?:\\\\?")${NAME}(?:\\\\?")\\s*:\\s*\\\\?")(?!\\[REDACTED)[^"\\\\]{4,}(\\\\?")`, 'gi'), '$1[REDACTED]$2'],
  // FOO_API_KEY=…  /  password: …  (value at least 12 chars, so `max_tokens: 4096` survives)
  [new RegExp(`\\b(${NAME})(\\s*[=:]\\s*)(?!\\[REDACTED)(['"]?)[A-Za-z0-9._~+/=:@-]{12,}\\3`, 'gi'), '$1$2$3[REDACTED]$3'],
];

export function redactSecretShapes(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}
