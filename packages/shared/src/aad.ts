// ADR-001: the AAD binds a ciphertext to its item, its field and the format version,
// so a compromised server cannot move an encrypted code from one item to another.
export const FORMAT_VERSION = 1;

const SEPARATOR = '|';

export function aad(itemId: string, field: string, version: number = FORMAT_VERSION): string {
  for (const part of [itemId, field]) {
    // A separator inside a part would let two different (item, field) pairs produce the same AAD.
    if (part === '' || part.includes(SEPARATOR)) throw new Error(`Invalid AAD part: ${JSON.stringify(part)}`);
  }
  if (!Number.isInteger(version) || version < 1) throw new Error(`Invalid format version: ${version}`);
  return [itemId, field, `v${version}`].join(SEPARATOR);
}
