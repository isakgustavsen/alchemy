// Relative import (not `@/` alias) so this file runs under both Bun and Node
// without a paths-aware loader. This fixture is excluded from the test
// project's typecheck (see tsconfig.test.json) because the relative path
// crosses composite-project boundaries.
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { launch } from "../../../src/Local/RpcServer.ts";

/**
 * Minimal test fixture for `RpcServer.launch`. Registers a single service
 * keyed by `"Test.Echo"` which is what the parent looks up via
 * `getProvider("Test.Echo")`.
 */
export class TestEcho extends Context.Service<
  TestEcho,
  {
    echo: (msg: string) => Effect.Effect<string>;
    config: (key: string) => Effect.Effect<string, Config.ConfigError>;
    boom: () => Effect.Effect<never, { _tag: "Boom"; msg: string }>;
  }
>()("Test.Echo") {}

const TestEchoLive = Layer.effect(
  TestEcho,
  Effect.gen(function* () {
    const sidecarToken = yield* Config.string(
      "ALCHEMY_SIDECAR_PLUGIN_TOKEN",
    ).pipe(Config.option, Effect.map(Option.getOrUndefined));
    return {
      echo: (msg: string) => Effect.succeed(`echo:${msg}`),
      config: (key: string) =>
        key === "ALCHEMY_SIDECAR_PLUGIN_TOKEN" && sidecarToken !== undefined
          ? Effect.succeed(sidecarToken)
          : Config.string(key),
      boom: () => Effect.fail({ _tag: "Boom" as const, msg: "kaboom" }),
    };
  }),
);

launch(TestEchoLive);
