import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { findSecretLikeValue } from './secrets';

// Token-shaped fixtures are assembled at runtime so repository secret scanners do not flag test data.
describe('findSecretLikeValue', () => {
  it.each([
    [`use ${'sk' + '-proj-'}abcdefghijklmnopqrstuvwxyz123456 for generation`, 'OpenAI-style secret key'],
    [`${'sk' + '-ant-api03-'}abcdefghijklmnopqrstuvwxyz`, 'OpenAI-style secret key'],
    [`${'AK' + 'IA'}IOSFODNN7EXAMPLE`, 'AWS access key'],
    [`key ${'AI' + 'za'}SyD-1234567890abcdefghijklmnopqrstu`, 'Google API key'],
    [`${'gh' + 'p_'}abcdefghijklmnopqrstuvwxyz0123456789`, 'GitHub token'],
    [`${'h' + 'f_'}abcdefghijklmnopqrstuvwxyzABCDEFGH`, 'Hugging Face token'],
    [`${'r' + '8_'}abcdefghijklmnopqrstuvwxyzABCDEFGH`, 'Replicate token'],
    [`-----BEGIN ${'RSA PRIVATE'} KEY-----\nMIIE`, 'private key'],
    ['api_key = "a1b2c3d4e5f6g7h8i9"', 'credential assignment'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', 'bearer token'],
  ])('flags %s', (text, kind) => {
    expect(findSecretLikeValue(text)).toBe(kind);
  });

  it.each([
    'Soft window light, 35mm, shallow depth of field, warm tones',
    'Emma, 24, freckles, auburn hair, green eyes; seed 123456789',
    'Negative prompt: blurry, extra fingers, watermark, text',
    'Use the "sk-" prefix style for scene keys like sk-intro',
    'password reset scene: she forgets her password again',
    'Кинематографичный свет, мягкие тени, 50mm',
  ])('accepts ordinary prompt text: %s', (text) => {
    expect(findSecretLikeValue(text)).toBeNull();
  });

  it('never flags plain prose made of dictionary-like words', () => {
    const word = fc.stringMatching(/^[a-z]{1,10}$/);
    fc.assert(
      fc.property(fc.array(word, { minLength: 1, maxLength: 40 }), (words) => {
        expect(findSecretLikeValue(words.join(' '))).toBeNull();
      }),
    );
  });
});
