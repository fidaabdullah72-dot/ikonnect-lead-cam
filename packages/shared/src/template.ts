/**
 * Message templating: `{{variable}}` / `{{variable|fallback}}` substitution plus
 * spintax `{Hi|Hello|Salam}` (nestable) so that every outgoing message is unique.
 */

export type Rng = () => number;

export type TemplateVars = Record<string, string | number | null | undefined>;

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|([^}]*))?\}\}/g;
// Private-use code points never appear in normal text, so they make safe placeholders.
const PH_OPEN = '';
const PH_CLOSE = '';
const PLACEHOLDER_RE = /(\d+)/g;
const SPIN_RE = /\{([^{}]*)\}/;

/** Resolve spintax groups, innermost first. `{{vars}}` are left untouched. */
export function spin(text: string, rng: Rng = Math.random): string {
  const vars: string[] = [];
  let out = text.replace(VAR_RE, (m) => {
    vars.push(m);
    return `${PH_OPEN}${vars.length - 1}${PH_CLOSE}`;
  });

  // Guard against pathological input; each pass removes one group.
  for (let i = 0; i < 10_000; i++) {
    const match = SPIN_RE.exec(out);
    if (!match) break;
    const options = match[1]!.split('|');
    const pick = options[Math.floor(rng() * options.length)] ?? '';
    out = out.slice(0, match.index) + pick + out.slice(match.index + match[0].length);
  }

  return out.replace(PLACEHOLDER_RE, (_, idx: string) => vars[Number(idx)] ?? '');
}

/** Substitute `{{variables}}`. Unknown or empty variables use the fallback (or empty string). */
export function substitute(text: string, vars: TemplateVars): string {
  return text.replace(VAR_RE, (_m, key: string, fallback?: string) => {
    const value = vars[key];
    if (value === null || value === undefined || String(value).trim() === '') {
      return (fallback ?? '').trim();
    }
    return String(value);
  });
}

/** Full render: spintax first, then variables, then whitespace tidy-up. */
export function renderTemplate(text: string, vars: TemplateVars, rng: Rng = Math.random): string {
  const rendered = substitute(spin(text, rng), vars);
  return rendered
    .replace(/[ \t]+([,.!?])/g, '$1') // "Hi , there" -> "Hi, there" when a variable was empty
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Variable names referenced by a template. */
export function listVariables(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(VAR_RE)) names.add(m[1]!);
  return [...names];
}

/** Number of distinct messages the spintax can produce (capped). */
export function spintaxVariantCount(text: string, cap = 1_000_000): number {
  const masked = text.replace(VAR_RE, 'x');
  // Evaluate innermost groups first: a group's count is the sum of its options' counts,
  // and an option's count is the product of the groups inside it.
  const counts: number[] = [];
  let out = masked;
  for (let i = 0; i < 10_000; i++) {
    const match = SPIN_RE.exec(out);
    if (!match) break;
    let total = 0;
    for (const option of match[1]!.split('|')) {
      let product = 1;
      for (const ref of option.matchAll(PLACEHOLDER_RE)) product *= counts[Number(ref[1])] ?? 1;
      total += product;
    }
    counts.push(Math.min(total, cap));
    out = out.slice(0, match.index) + `${PH_OPEN}${counts.length - 1}${PH_CLOSE}` + out.slice(match.index + match[0].length);
  }
  let result = 1;
  for (const ref of out.matchAll(PLACEHOLDER_RE)) result *= counts[Number(ref[1])] ?? 1;
  return Math.min(result, cap);
}

export interface TemplateIssue {
  level: 'error' | 'warning';
  message: string;
}

/** Lint a template so the UI can warn before a campaign launches. */
export function lintTemplate(text: string, knownVariables: readonly string[]): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  if (!text.trim()) {
    issues.push({ level: 'error', message: 'Message is empty.' });
    return issues;
  }
  const unknown = listVariables(text).filter((v) => !knownVariables.includes(v));
  if (unknown.length) {
    issues.push({ level: 'error', message: `Unknown variable${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{{${u}}}`).join(', ')}` });
  }
  const masked = text.replace(VAR_RE, '');
  let depth = 0;
  for (const ch of masked) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) issues.push({ level: 'error', message: 'Unbalanced spintax braces { }.' });
  if (/https?:\/\/|www\./i.test(text)) {
    issues.push({ level: 'warning', message: 'Links in a first message raise the risk of being reported as spam.' });
  }
  if (text.length > 1000) {
    issues.push({ level: 'warning', message: 'Long messages get fewer replies. Aim for under 500 characters.' });
  }
  if (spintaxVariantCount(text) < 2) {
    issues.push({ level: 'warning', message: 'Add spintax like {Hi|Hello} so each message is unique.' });
  }
  return issues;
}

/** Deterministic RNG (mulberry32) for previews and tests. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
