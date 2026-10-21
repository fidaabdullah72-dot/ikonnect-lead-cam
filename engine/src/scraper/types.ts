export interface PlaceResult {
  /** Google place id (Places API) or the Maps feature id (browser) — used for dedupe. */
  placeId: string | null;
  name: string;
  phone: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  category: string | null;
  rating: number | null;
  reviews: number | null;
  mapsUrl: string | null;
  lat: number | null;
  lng: number | null;
  /** OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY | null */
  businessStatus: string | null;
}

/** A result card as first seen in Google's list, before its details are read. */
export interface CardRef {
  href: string;
  placeId: string | null;
  phone: string | null;
}

export interface SearchOutcome {
  /** New businesses (not already saved), up to the requested number. */
  places: PlaceResult[];
  /** Businesses Google listed, including already-saved ones. */
  listed: number;
  /** Listed businesses that were already saved (skipped). */
  known: number;
  /** Google's list ended (versus: we stopped because we had enough new ones). */
  exhausted: boolean;
}

export interface QualifyRules {
  min_rating?: number;
  min_reviews?: number;
  require_mobile?: boolean;
  skip_closed?: boolean;
  website?: 'any' | 'with' | 'without';
  exclude_keywords?: string[];
}
