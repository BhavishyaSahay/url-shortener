import argon2 from 'argon2';

// Password hashing with Argon2id, the OWASP-recommended algorithm (winner of
// the 2015 Password Hashing Competition). A hash is one-way: we can check a
// password against it, but can't recover the password, even if the database leaks.
//
// Parameters follow the OWASP minimum recommendation (19 MiB memory, 2
// iterations). Argon2 is deliberately "memory-hard": each guess needs 19 MiB
// of RAM, which makes GPU/ASIC brute-forcing expensive. The trade-off is that
// our server also pays 19 MiB and ~25-30 ms per login, so we don't crank it
// higher on a small EC2 instance.
//
// Each hash embeds a random salt and the parameters, e.g.
//   $argon2id$v=19$m=19456,p=1,t=2$<salt>$<hash>
// so two users with the same password get different hashes, and the
// parameters can be raised later without breaking old hashes.
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // KiB = 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password) {
  return argon2.hash(password, HASH_OPTIONS);
}

export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed hash in the database must never crash the login endpoint.
    return false;
  }
}

// Used when a login attempt names an email that doesn't exist. Verifying
// against a dummy hash makes that response take as long as a wrong-password
// response, so response timing doesn't reveal which emails are registered.
let dummyHashPromise;
export async function verifyAgainstDummyHash(password) {
  dummyHashPromise ??= hashPassword('dummy-password-for-timing-safety');
  await verifyPassword(await dummyHashPromise, password);
  return false;
}
