import { describe, expect, it } from 'vitest';
import { redactForLog } from './services';

describe('log redaction (T171)', () => {
  it('removes credentials, MFA codes, tokens, notes and URL signatures', () => {
    const out = redactForLog({
      email: 'a@b.test',
      password: 'correct horse',
      code: '123456',
      recoveryCode: 'abcd-efgh',
      sessionToken: 'xyz',
      contactNotes: 'private text',
      errorCode: 'VALIDATION_FAILED',
      nested: { apiSecret: 's', url: 'https://s3.test/key?X-Amz-Signature=abc123&x=1' },
      list: [{ token: 't' }],
    }) as Record<string, unknown>;
    expect(out.email).toBe('a@b.test');
    expect(out.errorCode).toBe('VALIDATION_FAILED');
    for (const k of ['password', 'code', 'recoveryCode', 'sessionToken', 'contactNotes']) expect(out[k]).toBe('[redacted]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.apiSecret).toBe('[redacted]');
    expect(nested.url).toBe('https://s3.test/key?X-Amz-Signature=[redacted]&x=1');
    expect((out.list as Record<string, unknown>[])[0]!.token).toBe('[redacted]');
  });
});
