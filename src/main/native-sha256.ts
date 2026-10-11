/**
 * The SHA-256 the main process installs for the shared Markdown layer.
 *
 * `crypto.hash` is Node's one-shot digest. It gives the digest
 * `createHash('sha256').update(value).digest('hex')` gives, without building
 * a Hash object per call. That object was most of the cost of hashing every
 * block on open: 43,970 small strings on the 8 MB benchmark document took
 * about 44 ms through `createHash` and about 19 ms through `crypto.hash` in
 * Electron's Node.
 */
import { createHash, hash } from 'node:crypto';

export function nativeSha256(value: Uint8Array | string): string {
  return typeof hash === 'function'
    ? hash('sha256', value, 'hex')
    : createHash('sha256').update(value).digest('hex');
}
