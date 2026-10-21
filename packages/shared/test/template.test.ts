import { describe, expect, it } from 'vitest';
import { lintTemplate, listVariables, renderTemplate, seededRng, spin, spintaxVariantCount, substitute } from '../src/template';

describe('spin', () => {
  it('picks one option per group, including nested groups', () => {
    const outputs = new Set<string>();
    for (let i = 0; i < 200; i++) outputs.add(spin('{Hi|Hello {there|friend}}!', seededRng(i)));
    expect(outputs).toEqual(new Set(['Hi!', 'Hello there!', 'Hello friend!']));
  });

  it('leaves {{variables}} alone', () => {
    expect(spin('{Hi|Hi} {{business_name}}', seededRng(1))).toBe('Hi {{business_name}}');
    expect(spin('{{name|there}}', seededRng(1))).toBe('{{name|there}}');
  });

  it('is deterministic with a seeded rng', () => {
    expect(spin('{a|b|c|d}', seededRng(42))).toBe(spin('{a|b|c|d}', seededRng(42)));
  });
});

describe('substitute', () => {
  it('fills variables and falls back when empty', () => {
    expect(substitute('Hi {{business_name}} in {{city|your city}}', { business_name: 'Smile', city: '' })).toBe('Hi Smile in your city');
    expect(substitute('Hi {{ missing }}', {})).toBe('Hi ');
  });
});

describe('renderTemplate', () => {
  it('spins, substitutes and tidies spacing', () => {
    const msg = renderTemplate('{Hi|Hi} {{contact_name}}, we saw {{business_name}} !', { business_name: 'FitZone' }, seededRng(3));
    expect(msg).toBe('Hi, we saw FitZone!');
  });

  it('does not treat braces inside variable values as spintax', () => {
    expect(renderTemplate('Hello {{business_name}}', { business_name: 'A {B|C}' }, seededRng(1))).toBe('Hello A {B|C}');
  });
});

describe('helpers', () => {
  it('lists variables', () => {
    expect(listVariables('{{a}} {{b|x}} {{a}}')).toEqual(['a', 'b']);
  });

  it('counts spintax variants', () => {
    expect(spintaxVariantCount('plain')).toBe(1);
    expect(spintaxVariantCount('{a|b} {c|d|e}')).toBe(6);
    expect(spintaxVariantCount('{a|b {c|d}}')).toBe(3);
    expect(spintaxVariantCount('{{x}} {a|b}')).toBe(2);
  });

  it('lints templates', () => {
    const vars = ['business_name'];
    expect(lintTemplate('', vars)[0]?.level).toBe('error');
    expect(lintTemplate('{Hi|Hello} {{nope}}', vars).some((i) => i.message.includes('{{nope}}'))).toBe(true);
    expect(lintTemplate('{Hi|Hello there', vars).some((i) => i.message.includes('Unbalanced'))).toBe(true);
    expect(lintTemplate('{Hi|Hello} see https://x.com', vars).some((i) => i.level === 'warning')).toBe(true);
    expect(lintTemplate('{Hi|Hello} {{business_name}}', vars)).toEqual([]);
  });
});

import { buildTemplateVars, estimateCampaignDuration, isOptOut, normalizeCampaignSettings } from '../src/campaign';

describe('campaign helpers', () => {
  it('normalizes settings and clamps unsafe values', () => {
    const s = normalizeCampaignSettings({ min_delay_sec: 1, max_delay_sec: 5, batch_size: 0, window: { start: '25:00', days: [0, 9, 3, 3] } }, 'Asia/Karachi');
    expect(s.min_delay_sec).toBe(10);
    expect(s.max_delay_sec).toBe(10);
    expect(s.batch_size).toBe(1);
    expect(s.window.start).toBe('10:00');
    expect(s.window.days).toEqual([3]);
    expect(s.window.timezone).toBe('Asia/Karachi');
  });

  it('builds template variables from a lead', () => {
    const v = buildTemplateVars({ business_name: 'Smile', contact_name: 'Ahmed Khan', website: 'https://www.smile.pk/' }, { sender_name: 'Sara' });
    expect(v).toMatchObject({ business_name: 'Smile', first_name: 'Ahmed', website: 'smile.pk', sender_name: 'Sara' });
  });

  it('estimates duration', () => {
    const e = estimateCampaignDuration(200, 2, { min_delay_sec: 60, max_delay_sec: 120, batch_size: 20, batch_pause_min: 10, daily_limit: null, window: { start: '10:00', end: '19:00', days: [1], timezone: 'UTC' } }, 40);
    expect(e.perDay).toBe(80);
    expect(e.days).toBe(3);
  });

  it('detects opt-outs without false positives', () => {
    const kw = ['stop', 'unsubscribe', 'not interested'];
    expect(isOptOut('STOP', kw)).toBe(true);
    expect(isOptOut('stop.', kw)).toBe(true);
    expect(isOptOut('Not interested, thanks', kw)).toBe(true);
    expect(isOptOut('Can you stop by tomorrow?', kw)).toBe(false);
    expect(isOptOut('not interested', kw)).toBe(true);
    expect(isOptOut("Please don't stop sending me offers about websites, very useful", kw)).toBe(false);
  });
});
