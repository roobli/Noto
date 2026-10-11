import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  collectDigestClaims,
  isNotoDocumentWire,
  sha256Hex,
  verifyDigestClaims,
  webCryptoSha256,
} from '../../src/shared/file-truth/v1/validate';
import { parseDocument, toWire } from '../../src/shared/markdown/v3/document';

/**
 * The preload still checks every document against its envelope hash, but the
 * hash now runs in Web Crypto instead of the plain JavaScript SHA-256. These
 * pin the two to the same digest and the same verdict.
 */
const native = webCryptoSha256();

function bytesOf(text: string, bom = false): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

function wireOf(text: string) {
  const parsed = parseDocument(bytesOf(text));
  if (parsed.status !== 'parsed') throw new Error(parsed.message);
  return structuredClone(toWire(parsed.document));
}

describe('the native digest the preload uses', () => {
  it('is available where the preload runs', () => {
    expect(native).not.toBeNull();
  });

  it('matches the JavaScript SHA-256 on every padding boundary and on real text', async () => {
    const inputs: Uint8Array[] = [
      new Uint8Array(0),
      bytesOf('abc'),
      bytesOf('# 标题\n\n中文、emoji 🙂 and a lone \ud800 surrogate\n'),
      bytesOf('BOM first\n', true),
      ...[55, 56, 57, 63, 64, 65, 119, 120, 128].map((length) => new Uint8Array(randomBytes(length))),
      new Uint8Array(randomBytes(3 * 1024 * 1024 + 17)),
    ];
    for (const input of inputs) {
      const expected = createHash('sha256').update(input).digest('hex');
      expect(sha256Hex(input)).toBe(expected);
      expect(await native!(input)).toBe(expected);
    }
  });
});

describe('collected digest claims', () => {
  const text = '---\ntitle: x\n---\n\n# Heading\n\nBody with **marks** and 中文.\n\n- a\n- b\n';

  it('accepts a document whose text matches its envelope, like the synchronous check', async () => {
    const wire = wireOf(text);
    expect(isNotoDocumentWire(wire)).toBe(true);
    const { result, claims } = collectDigestClaims(() => isNotoDocumentWire(wire));
    expect(result).toBe(true);
    expect(claims).toHaveLength(1);
    expect(await verifyDigestClaims(claims)).toBe(true);
    expect(await verifyDigestClaims(claims, null)).toBe(true);
  });

  it('refuses text that no longer matches its envelope, like the synchronous check', async () => {
    const wire = { ...wireOf(text), text: text.replace('Body', 'Bxdy') };
    expect(isNotoDocumentWire(wire)).toBe(false);
    const { result, claims } = collectDigestClaims(() => isNotoDocumentWire(wire));
    // Structure is fine; only the hash gives the forgery away.
    expect(result).toBe(true);
    expect(await verifyDigestClaims(claims)).toBe(false);
    expect(await verifyDigestClaims(claims, null)).toBe(false);
  });

  it('puts a byte-order mark back before hashing', async () => {
    const parsed = parseDocument(bytesOf(text, true));
    if (parsed.status !== 'parsed') throw new Error(parsed.message);
    const wire = structuredClone(toWire(parsed.document));
    expect(wire.envelope.bom).toBe('utf8');
    const { result, claims } = collectDigestClaims(() => isNotoDocumentWire(wire));
    expect(result).toBe(true);
    expect(await verifyDigestClaims(claims)).toBe(true);
  });

  it('only collects inside the call, and hashes synchronously outside it', () => {
    const wire = { ...wireOf(text), text: text.replace('Body', 'Bxdy') };
    collectDigestClaims(() => undefined);
    expect(isNotoDocumentWire(wire)).toBe(false);
  });
});
