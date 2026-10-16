// White-label hooks. Everything user-visible that upstream hard-coded lives
// here instead, so re-syncing the vendored client only needs the five string
// swaps in scripts/apply-local-patches.py.
//
// Values come from `window.__RD__.brand`, set in web/config.js (or per link via
// query params). Colours are applied as CSS custom properties by
// web/index.html, so no stylesheet is touched.

export type BrandConfig = {
  /** Product name shown in the title and the connect overlay. */
  name?: string;
  /** Logo URL, relative to the page. */
  logoUrl?: string;
  /** Slug used for download filenames and localStorage keys. */
  slug?: string;
  accent?: string;
  accent2?: string;
  accentFg?: string;
};

// AnDesk's palette is taken from andesk.ico: navy ground (#133460), periwinkle
// lettering (#90BCFF), cyan rim (#35AACA).
export const BRAND_DEFAULTS: Required<BrandConfig> = {
  name: 'AnDesk',
  logoUrl: './logo.png',
  slug: 'andesk',
  accent: '#4c8dff',
  accent2: '#3a6fd8',
  accentFg: '#ffffff',
};

export function brand(): Required<BrandConfig> {
  const injected = (globalThis as { __RD__?: { brand?: BrandConfig } }).__RD__?.brand;
  return { ...BRAND_DEFAULTS, ...(injected ?? {}) };
}

export function brandName(): string {
  return brand().name;
}

export function brandLogo(): string {
  return brand().logoUrl;
}

export function brandSlug(): string {
  return brand().slug;
}

/**
 * Split the name for the two-tone wordmark (upstream renders "Corten" + "Desk"
 * with the second half in the accent colour). Splits at the first camel-case
 * boundary; a single-word name lands entirely in the first span.
 */
export function brandWordmark(): [string, string] {
  const name = brandName();
  const i = name.slice(1).search(/[A-Z]/);
  if (i < 0) return [name, ''];
  const cut = i + 1;
  return [name.slice(0, cut), name.slice(cut)];
}

/** Apply the palette as CSS variables. Safe to call before the app mounts. */
export function applyBrandTheme(root?: HTMLElement): void {
  const el = root ?? (typeof document !== 'undefined' ? document.documentElement : undefined);
  if (!el?.style) return;
  const b = brand();
  el.style.setProperty('--rd-accent', b.accent);
  el.style.setProperty('--rd-accent-2', b.accent2);
  el.style.setProperty('--rd-accent-fg', b.accentFg);
}
