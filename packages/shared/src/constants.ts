export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: 'Full control, including deleting the workspace',
  admin: 'Manage team, settings and every campaign',
  member: 'Work leads, connect WhatsApp, run own campaigns',
  viewer: 'Read-only access',
};

export const canWrite = (role: Role | null | undefined) => role === 'owner' || role === 'admin' || role === 'member';
export const isAdminRole = (role: Role | null | undefined) => role === 'owner' || role === 'admin';

export const STAGE_KINDS = ['new', 'contacted', 'replied', 'open', 'won', 'lost'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const LEAD_SOURCES = ['scraper', 'import', 'manual', 'inbound'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const SOURCE_LABELS: Record<LeadSource, string> = {
  scraper: 'Google Maps',
  import: 'CSV import',
  manual: 'Added manually',
  inbound: 'Inbound WhatsApp',
};

export const WA_ACCOUNT_STATUSES = ['disconnected', 'connecting', 'qr', 'pairing', 'connected', 'logged_out', 'error'] as const;
export type WaAccountStatus = (typeof WA_ACCOUNT_STATUSES)[number];

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const RECIPIENT_STATUSES = ['pending', 'waiting', 'sending', 'completed', 'replied', 'failed', 'skipped', 'cancelled'] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const MESSAGE_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'received'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Variables available in templates, with sample values for previews. */
export const TEMPLATE_VARIABLES = [
  { key: 'business_name', label: 'Business name', sample: 'Smile Dental Clinic' },
  { key: 'contact_name', label: 'Contact name', sample: 'Dr. Ahmed' },
  { key: 'first_name', label: 'Contact first name', sample: 'Ahmed' },
  { key: 'city', label: 'City', sample: 'Lahore' },
  { key: 'category', label: 'Category', sample: 'Dentist' },
  { key: 'website', label: 'Website', sample: 'smiledental.pk' },
  { key: 'address', label: 'Address', sample: 'Gulberg III, Lahore' },
  { key: 'rating', label: 'Google rating', sample: '4.6' },
  { key: 'reviews_count', label: 'Google reviews', sample: '128' },
  { key: 'sender_name', label: 'Your name', sample: 'Sara' },
  { key: 'company_name', label: 'Your company', sample: 'Pixel Agency' },
] as const;

export const TEMPLATE_VARIABLE_KEYS: readonly string[] = TEMPLATE_VARIABLES.map((v) => v.key);

export const DEFAULT_OPT_OUT_KEYWORDS = ['stop', 'unsubscribe', 'remove', 'not interested'];

/** Preset categories for the scraper job builder (free text is also allowed). */
export const BUSINESS_CATEGORIES: Record<string, string[]> = {
  Healthcare: ['Clinics', 'Dentists', 'Dermatologists', 'Physiotherapy Centers', 'Hospitals', 'Pharmacies', 'Medical Labs', 'Eye Clinics', 'Veterinary Clinics'],
  'Real Estate': ['Real Estate Agencies', 'Property Dealers', 'Builders and Developers', 'Interior Designers', 'Architects'],
  'Beauty & Fitness': ['Gyms', 'Yoga Studios', 'Salons', 'Beauty Parlors', 'Spas', 'Barber Shops', 'Nail Salons'],
  'Professional Services': ['Law Firms', 'Accounting Firms', 'Tax Consultants', 'Marketing Agencies', 'Recruitment Agencies', 'Insurance Agencies', 'Consultants'],
  Education: ['Schools', 'Coaching Centers', 'Training Institutes', 'Tuition Centers', 'Language Schools', 'Driving Schools'],
  Automotive: ['Car Dealerships', 'Auto Repair Shops', 'Car Wash', 'Car Rentals', 'Tyre Shops'],
  'Food & Hospitality': ['Restaurants', 'Cafes', 'Bakeries', 'Catering Services', 'Hotels', 'Guest Houses', 'Wedding Halls', 'Event Planners'],
  'Retail & Trade': ['Clothing Stores', 'Furniture Stores', 'Electronics Stores', 'Jewelry Stores', 'Mobile Phone Shops', 'Hardware Stores', 'Supermarkets'],
  'Home Services': ['Plumbers', 'Electricians', 'Pest Control', 'Cleaning Services', 'Solar Panel Installers', 'Movers'],
  Travel: ['Travel Agencies', 'Tour Operators', 'Visa Consultants'],
};

export const PRESET_LOCATIONS: Record<string, string[]> = {
  Pakistan: ['Lahore', 'Karachi', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Peshawar', 'Gujranwala', 'Sialkot', 'Quetta', 'Hyderabad', 'Bahawalpur'],
  UAE: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman'],
  'Saudi Arabia': ['Riyadh', 'Jeddah', 'Dammam', 'Mecca', 'Medina'],
  'United Kingdom': ['London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow'],
  'United States': ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Miami', 'Dallas'],
  Canada: ['Toronto', 'Vancouver', 'Montreal', 'Calgary'],
  Australia: ['Sydney', 'Melbourne', 'Brisbane', 'Perth'],
};

export const COUNTRIES: Array<{ code: string; name: string; timezone: string }> = [
  { code: 'PK', name: 'Pakistan', timezone: 'Asia/Karachi' },
  { code: 'AE', name: 'United Arab Emirates', timezone: 'Asia/Dubai' },
  { code: 'SA', name: 'Saudi Arabia', timezone: 'Asia/Riyadh' },
  { code: 'IN', name: 'India', timezone: 'Asia/Kolkata' },
  { code: 'BD', name: 'Bangladesh', timezone: 'Asia/Dhaka' },
  { code: 'GB', name: 'United Kingdom', timezone: 'Europe/London' },
  { code: 'US', name: 'United States', timezone: 'America/New_York' },
  { code: 'CA', name: 'Canada', timezone: 'America/Toronto' },
  { code: 'AU', name: 'Australia', timezone: 'Australia/Sydney' },
  { code: 'QA', name: 'Qatar', timezone: 'Asia/Qatar' },
  { code: 'KW', name: 'Kuwait', timezone: 'Asia/Kuwait' },
  { code: 'OM', name: 'Oman', timezone: 'Asia/Muscat' },
  { code: 'BH', name: 'Bahrain', timezone: 'Asia/Bahrain' },
  { code: 'TR', name: 'Türkiye', timezone: 'Europe/Istanbul' },
  { code: 'EG', name: 'Egypt', timezone: 'Africa/Cairo' },
  { code: 'NG', name: 'Nigeria', timezone: 'Africa/Lagos' },
  { code: 'ZA', name: 'South Africa', timezone: 'Africa/Johannesburg' },
  { code: 'MY', name: 'Malaysia', timezone: 'Asia/Kuala_Lumpur' },
  { code: 'ID', name: 'Indonesia', timezone: 'Asia/Jakarta' },
  { code: 'DE', name: 'Germany', timezone: 'Europe/Berlin' },
  { code: 'FR', name: 'France', timezone: 'Europe/Paris' },
];

export const STAGE_COLORS = ['#64748b', '#3b82f6', '#06b6d4', '#8b5cf6', '#f59e0b', '#ec4899', '#10b981', '#ef4444', '#84cc16', '#f97316'];

let countryList: Array<{ code: string; name: string }> | null = null;

/** Every country (ISO code + English name), sorted by name — for pickers. */
export function allCountries(): Array<{ code: string; name: string }> {
  if (countryList) return countryList;
  const dn = new Intl.DisplayNames(['en'], { type: 'region' });
  const out: Array<{ code: string; name: string }> = [];
  for (let i = 0; i < 26; i++)
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(65 + i, 65 + j);
      try {
        const name = dn.of(code);
        // Skip unassigned codes and groupings ("EU", "UN", "Unknown Region").
        if (name && name !== code && !/region|union|nations|outlying|^world$/i.test(name) && !['EZ', 'QO', 'XA', 'XB', 'ZZ'].includes(code)) out.push({ code, name });
      } catch {
        /* not a region */
      }
    }
  return (countryList = out.sort((a, b) => a.name.localeCompare(b.name)));
}

/** "Pakistan" for "PK" (falls back to the code). */
export function countryName(code: string | null | undefined): string {
  if (!code) return '';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
