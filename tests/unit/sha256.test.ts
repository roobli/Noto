import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { portableSha256 as sha256, sha256 as activeSha256, useSha256 } from '../../src/shared/sha256';

const reference = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

describe('portable sha256', () => {
  it('matches the FIPS 180-4 examples', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with node:crypto on every length across the padding boundaries', () => {
    for (let length = 0; length <= 200; length += 1) {
      const bytes = randomBytes(length);
      expect(sha256(bytes), `bytes of length ${length}`).toBe(reference(bytes));
    }
  });

  it('hashes strings as UTF-8, multi-byte text and lone surrogates included', () => {
    for (const text of ['é', '漢字', '😀', 'a\r\nb', '﻿# Title\n', 'x\ud800y', '\udfff']) {
      for (const repeat of [1, 7, 64, 3000]) {
        const value = text.repeat(repeat);
        expect(sha256(value), `${JSON.stringify(text)} x ${repeat}`).toBe(reference(value));
      }
    }
  });

  it('gives the same digest for a string and its UTF-8 bytes', () => {
    const text = '# Notes\n\n- [x] 完成\n';
    expect(sha256(text)).toBe(sha256(new TextEncoder().encode(text)));
  });

  it('handles inputs larger than its kept buffer, then small ones again', () => {
    const large = 'Lorem ipsum 中文 😀\n'.repeat(20_000);
    expect(sha256(large)).toBe(reference(large));
    const bytes = randomBytes(1_000_003);
    expect(sha256(bytes)).toBe(reference(bytes));
    expect(sha256('abc')).toBe(reference('abc'));
  });

  it('reads only the view it is given', () => {
    const backing = randomBytes(256);
    const view = backing.subarray(17, 150);
    expect(sha256(view)).toBe(reference(view));
  });

  it('delegates to an installed implementation, which changes speed and not results', () => {
    const seen: (Uint8Array | string)[] = [];
    useSha256((value) => {
      seen.push(value);
      return reference(value);
    });
    try {
      expect(activeSha256('abc')).toBe(sha256('abc'));
      expect(seen).toEqual(['abc']);
    } finally {
      useSha256(sha256);
    }
    expect(activeSha256('abc')).toBe(reference('abc'));
  });
});
