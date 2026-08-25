// ── Token generation & hashing ──
//
// The credential token doubles as both the bearer secret used in the
// Authorization header AND the human-typeable manual-entry code shown on the
// success page — one opaque value, two presentations. Crockford base32 (no
// I/L/O/U) keeps the manual-entry path free of easily-confused characters.

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function toCrockfordBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** A fresh 25-character opaque credential, grouped for manual entry as
 *  "BETH-XXXXX-XXXXX-XXXXX-XXXXX". The grouped form IS the token — there is
 *  no separate un-grouped variant; strip hyphens before hashing/comparing. */
export function generateCredentialToken(): string {
  const raw = crypto.getRandomValues(new Uint8Array(16)); // 128 bits of entropy
  const encoded = toCrockfordBase32(raw).slice(0, 20).padEnd(20, "0");
  const groups = encoded.match(/.{1,5}/g) ?? [encoded];
  return `BETH-${groups.join("-")}`;
}

/** Normalize a token before hashing/lookup — strips whitespace and hyphens so
 *  "BETH-ABCDE-..." and a copy-pasted variant with stray spaces hash the same. */
export function normalizeToken(token: string): string {
  return token.trim().toUpperCase().replace(/[\s-]/g, "");
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashToken(token: string): Promise<string> {
  return sha256Hex(normalizeToken(token));
}
