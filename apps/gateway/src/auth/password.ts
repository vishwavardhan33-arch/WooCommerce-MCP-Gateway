import { hash, verify } from "@node-rs/argon2";

// Argon2id is the library's default algorithm (a test pins this). These cost settings are the
// OWASP-recommended minimum: 19 MiB of memory, 2 passes, 1 thread. Memory is the point: it makes
// guessing passwords on GPUs expensive. They are stored INSIDE the hash string, so we can raise them
// later and old hashes keep verifying.
const COST = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string): Promise<string> => hash(password, COST);

// A stored value that is not a valid argon2 hash makes the library throw. For a login check the
// right answer to "is this valid?" is simply "no", not a crash.
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}
