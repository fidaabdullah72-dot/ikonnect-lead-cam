import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

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

let callingCodes: Array<{ code: string; label: string }> | null = null;

/** Country calling codes for pickers: `{ code: '92', label: '+92 Pakistan' }`, most common first, then by code. */
export function phoneCallingCodes(): Array<{ code: string; label: string }> {
  if (callingCodes) return callingCodes;
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  // Codes shared by several countries are named after the main ones first ("+1 United States, Canada").
  const main: Record<string, string[]> = { '1': ['US', 'CA'], '7': ['RU', 'KZ'], '44': ['GB'], '47': ['NO'], '61': ['AU'], '39': ['IT'], '212': ['MA'], '358': ['FI'], '590': ['GP'], '599': ['CW'], '262': ['RE'], '290': ['SH'] };
  const byCode = new Map<string, string[]>();
  for (const c of getCountries()) {
    const code = getCountryCallingCode(c);
    byCode.set(code, [...(byCode.get(code) ?? []), c as string]);
  }
  for (const [code, regions] of byCode) {
    const lead = main[code] ?? [];
    byCode.set(code, [...lead.filter((r) => regions.includes(r as CountryCode)), ...regions.filter((r) => !lead.includes(r))].map((r) => names.of(r) ?? r));
  }
  const first = ['92', '971', '966', '44', '1', '91', '880', '974', '965', '968', '973', '61', '49', '90'];
  const label = (code: string) => {
    const n = byCode.get(code)!;
    return `+${code} ${n.length > 2 ? `${n.slice(0, 2).join(', ')} +${n.length - 2}` : n.join(', ')}`;
  };
  const rest = [...byCode.keys()].filter((c) => !first.includes(c)).sort((a, b) => Number(a) - Number(b));
  return (callingCodes = [...first.filter((c) => byCode.has(c)), ...rest].map((code) => ({ code, label: label(code) })));
}
