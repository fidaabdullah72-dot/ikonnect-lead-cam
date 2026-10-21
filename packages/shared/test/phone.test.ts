import { describe, expect, it } from 'vitest';
import { formatPhone, jidToDigits, normalizePhone } from '../src/phone';

describe('normalizePhone', () => {
  it('converts Pakistani local mobile numbers to international digits', () => {
    expect(normalizePhone('0300 1234567')).toMatchObject({ digits: '923001234567', type: 'mobile', valid: true, country: 'PK' });
    expect(normalizePhone('03001234567')?.digits).toBe('923001234567');
  });

  it('accepts +, 00 and bare international formats', () => {
    expect(normalizePhone('+92 300 1234567')?.digits).toBe('923001234567');
    expect(normalizePhone('0092 300 1234567')?.digits).toBe('923001234567');
    expect(normalizePhone('923001234567')?.digits).toBe('923001234567');
  });

  it('detects landlines', () => {
    expect(normalizePhone('042 35761234')).toMatchObject({ digits: '924235761234', type: 'landline' });
  });

  it('respects the default country', () => {
    expect(normalizePhone('(415) 555-2671', 'US')?.digits).toBe('14155552671');
    expect(normalizePhone('020 7946 0958', 'GB')?.digits).toBe('442079460958');
  });

  it('rejects junk', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('call us')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats stored digits', () => {
    expect(formatPhone('923001234567')).toBe('+92 300 1234567');
  });

  it('extracts digits from jids', () => {
    expect(jidToDigits('923001234567@s.whatsapp.net')).toBe('923001234567');
    expect(jidToDigits('923001234567:12@s.whatsapp.net')).toBe('923001234567');
    expect(jidToDigits('12036302@g.us')).toBe('12036302');
    expect(jidToDigits('abc@lid')).toBeNull();
  });
});
