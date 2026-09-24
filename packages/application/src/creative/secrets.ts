/**
 * Character prompt fields must never store generator API keys or other credentials (section 9).
 * This is a conservative detector for well-known credential shapes plus explicit "key = value"
 * assignments; ordinary creative prompt text never matches.
 */
const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'OpenAI-style secret key', re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/ },
  { kind: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/ },
  { kind: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,}\b/ },
  { kind: 'Replicate token', re: /\br8_[A-Za-z0-9]{30,}\b/ },
  { kind: 'Stripe key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { kind: 'private key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { kind: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/i },
  {
    kind: 'credential assignment',
    re: /\b(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}/i,
  },
];

/** Returns a human description of the credential kind found in `text`, or null. */
export const findSecretLikeValue = (text: string | null | undefined): string | null => {
  if (!text) return null;
  for (const p of PATTERNS) if (p.re.test(text)) return p.kind;
  return null;
};
