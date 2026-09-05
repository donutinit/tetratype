import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/settings';

describe('normalizeSettings', () => {
  test('returns the defaults for missing input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  test('keeps valid values', () => {
    const settings = normalizeSettings({ breakOnPauseMs: 750, capture: false, minSamples: 12 });
    expect(settings.breakOnPauseMs).toBe(750);
    expect(settings.capture).toBe(false);
    expect(settings.minSamples).toBe(12);
  });

  test('clamps numbers into their supported range', () => {
    expect(normalizeSettings({ breakOnPauseMs: 5 }).breakOnPauseMs).toBe(200);
    expect(normalizeSettings({ breakOnPauseMs: 999999 }).breakOnPauseMs).toBe(10000);
    expect(normalizeSettings({ recentWindow: 1 }).recentWindow).toBe(8);
    expect(normalizeSettings({ maxGrams: 10 }).maxGrams).toBe(500);
  });

  test('rounds fractional values', () => {
    expect(normalizeSettings({ recentWindow: 40.7 }).recentWindow).toBe(41);
  });

  test('falls back when a value is the wrong type', () => {
    const settings = normalizeSettings({ capture: 'yes', breakOnPauseMs: 'soon' });
    expect(settings.capture).toBe(DEFAULT_SETTINGS.capture);
    expect(settings.breakOnPauseMs).toBe(DEFAULT_SETTINGS.breakOnPauseMs);
  });

  test('coerces numeric strings, as HTML inputs produce', () => {
    expect(normalizeSettings({ minSamples: '20' }).minSamples).toBe(20);
  });

  test('ignores unknown keys', () => {
    expect(normalizeSettings({ nonsense: 1 })).toEqual(DEFAULT_SETTINGS);
  });
});
