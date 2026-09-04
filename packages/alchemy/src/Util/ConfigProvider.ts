import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SecretsEnvironment } from "../SecretsEnvironment.ts";
import type { SecretsResolver } from "../Secrets.ts";

export const loadConfigProvider = (envFile: Option.Option<string>) => {
  if (Option.isSome(envFile)) {
    return ConfigProvider.fromDotEnv({ path: envFile.value }).pipe(
      Effect.map((dotEnv) =>
        ConfigProvider.orElse(dotEnv, ConfigProvider.fromEnv()),
      ),
    );
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(".env");
    if (!exists) {
      return ConfigProvider.fromEnv();
    }
    return ConfigProvider.orElse(
      yield* ConfigProvider.fromDotEnv({ path: ".env" }),
      ConfigProvider.fromEnv(),
    );
  });
};

export interface StackConfigResolution {
  readonly provider: ConfigProvider.ConfigProvider;
  /**
   * Present only when a custom stack resolver owns configuration loading.
   * An empty object still means "do not fall back to dotenv" in a sidecar.
   */
  readonly environment?: Readonly<Record<string, string>>;
}

/** Resolve a stack's custom secrets provider or retain Alchemy's defaults. */
export const loadStackConfigProvider = (
  resolver: SecretsResolver | undefined,
  envFile: Option.Option<string>,
) =>
  resolver === undefined
    ? loadConfigProvider(envFile).pipe(
        Effect.map((provider): StackConfigResolution => ({ provider })),
      )
    : resolver.resolve({ envFile: Option.getOrUndefined(envFile) });

/** Make resolved custom values available to out-of-process local providers. */
export const secretsEnvironmentLayer = (resolution: StackConfigResolution) =>
  resolution.environment === undefined
    ? Layer.empty
    : Layer.succeed(SecretsEnvironment, resolution.environment);
