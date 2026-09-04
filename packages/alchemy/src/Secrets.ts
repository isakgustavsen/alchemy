import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as ConfigProvider from "effect/ConfigProvider";

/** Context passed to a stack secrets resolver. */
export interface SecretsResolverOptions {
  /**
   * An explicit environment file supplied by Alchemy's `--env-file` flag.
   * Resolvers may interpret this as their native entry path.
   */
  readonly envFile?: string;
}

/** A resolved configuration provider and its process-compatible values. */
export interface SecretsResolution {
  readonly provider: ConfigProvider.ConfigProvider;
  /**
   * Values that must be forwarded to local provider sidecars. Undefined
   * values are omitted so Config defaults continue to work normally.
   */
  readonly environment: Readonly<Record<string, string>>;
}

/** A stack-level source for secrets and configuration values. */
export interface SecretsResolver {
  readonly resolve: (
    options: SecretsResolverOptions,
  ) => Effect.Effect<SecretsResolution, SecretsError>;
}

/** A sanitized failure reported by a stack secrets resolver. */
export class SecretsError extends Data.TaggedError("SecretsError")<{
  readonly source: string;
  readonly message: string;
  readonly exitCode?: number;
}> {}
