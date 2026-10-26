import type { Role } from "../db/schema.js";

// What the rest of the code knows about "who is calling". Deliberately small: never the password hash.
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}
