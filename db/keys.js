/**
 * Branch API keys.
 *
 * A branch identifies itself to the cloud with a long random key, not with a
 * staff PIN — the till's sync agent runs in the background with no session and
 * must keep working across restarts, and PINs are four digits.
 *
 * The key is shown exactly once, when the branch is provisioned. Only its
 * SHA-256 hash is stored, so this database can be dumped, backed up or leaked
 * without yielding a credential that can write to it.
 */

const crypto = require('crypto');

/** 256 bits of randomness, hex encoded. Long enough that guessing is not a threat model. */
function generateKey() {
  return crypto.randomBytes(32).toString('hex');
}

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

/**
 * Compare two hashes without leaking, through timing, how far they matched.
 *
 * Both are fixed-length hex, so a length mismatch means the input was not a
 * hash at all and can be rejected outright — `timingSafeEqual` throws on
 * differing lengths, and that throw would itself be an early exit.
 */
function hashesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

module.exports = { generateKey, hashKey, hashesMatch };
