import type { SecretsResolver } from "./Secrets.ts";
import { makeVarlock } from "./VarlockInternal.ts";

/**
 * Resolve a stack's secrets and configuration with Varlock.
 *
 * Varlock loads from the current workspace by default. Alchemy's
 * `--env-file` flag is forwarded as Varlock's `--path` option.
 */
export const varlock = (): SecretsResolver => makeVarlock();
