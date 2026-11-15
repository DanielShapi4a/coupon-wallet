import { describe, expect, it } from 'vitest';
import { aad, FORMAT_VERSION } from './aad.ts';

describe('aad', () => {
  it('binds item, field and format version', () => {
    expect(aad('item-1', 'code')).toBe(`item-1|code|v${FORMAT_VERSION}`);
    expect(aad('item-1', 'code', 2)).toBe('item-1|code|v2');
  });

  it('rejects the separator, so two different items cannot share an AAD', () => {
    expect(() => aad('a|b', 'c')).toThrow();
    expect(() => aad('a', 'b|c')).toThrow();
  });

  it('rejects empty parts and invalid versions', () => {
    expect(() => aad('', 'code')).toThrow();
    expect(() => aad('item-1', '')).toThrow();
    expect(() => aad('item-1', 'code', 0)).toThrow();
    expect(() => aad('item-1', 'code', 1.5)).toThrow();
  });
});
