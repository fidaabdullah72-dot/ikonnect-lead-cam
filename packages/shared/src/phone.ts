import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export type PhoneType = 'mobile' | 'landline' | 'unknown';

export interface NormalizedPhone {
  /** Digits only, international, no plus: `923001234567`. This is what we store and dedupe on. */
  digits: string;
  /** `+923001234567` */
  e164: string;
  /** `+92 300 1234567` */
  display: string;
  type: PhoneType;
  valid: boolean;
  country?: string;
}

/**
 * Normalise any scraped / imported / typed phone number.
 * Local numbers (`0300 1234567`) are interpreted in `defaultCountry`.
 * Returns null when there are not enough digits to be a phone number.
 */
export function normalizePhone(raw: string | null | undefined, defaultCountry = 'PK'): NormalizedPhone | null {
  if (!raw) return null;
  let input = String(raw).trim();
  if (!input) return null;

  // "0092..." -> "+92..."
  input = input.replace(/^00(?=[1-9])/, '+');
  const bareDigits = input.replace(/\D/g, '');
  if (bareDigits.length < 7) return null;

  // Bare international digits without a plus ("923001234567"): try them as international first.
  const candidates: Array<{ text: string; country?: CountryCode }> = [];
  if (input.startsWith('+')) {
    candidates.push({ text: input });
  } else {
    candidates.push({ text: input, country: defaultCountry as CountryCode });
    if (!bareDigits.startsWith('0')) candidates.push({ text: `+${bareDigits}` });
  }

  for (const c of candidates) {
    const parsed = parsePhoneNumberFromString(c.text, c.country);
    if (parsed && parsed.isValid()) {
      const type = parsed.getType();
      return {
        digits: parsed.number.replace(/^\+/, ''),
        e164: parsed.number,
        display: parsed.formatInternational(),
        type: type === 'MOBILE' || type === 'FIXED_LINE_OR_MOBILE' ? 'mobile' : type === 'FIXED_LINE' ? 'landline' : 'unknown',
        valid: true,
        country: parsed.country,
      };
    }
  }

  // Keep something usable even if libphonenumber can't validate it (new number ranges, etc).
  const parsed = parsePhoneNumberFromString(candidates[0]!.text, candidates[0]!.country);
  const digits = parsed?.number.replace(/^\+/, '') ?? bareDigits;
  return {
    digits,
    e164: `+${digits}`,
    display: parsed?.formatInternational() ?? `+${digits}`,
    type: 'unknown',
    valid: false,
    country: parsed?.country,
  };
}

/** Pretty-print stored digits (`923001234567` -> `+92 300 1234567`). */
export function formatPhone(digits: string | null | undefined): string {
  if (!digits) return '';
  const parsed = parsePhoneNumberFromString(`+${digits.replace(/\D/g, '')}`);
  return parsed ? parsed.formatInternational() : `+${digits}`;
}

export function toWhatsAppJid(digits: string): string {
  return `${digits.replace(/\D/g, '')}@s.whatsapp.net`;
}

/** `923001234567@s.whatsapp.net` or `923001234567:12@s.whatsapp.net` -> `923001234567` */
export function jidToDigits(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const user = jid.split('@')[0]?.split(':')[0] ?? '';
  return /^\d{7,15}$/.test(user) ? user : null;
}
