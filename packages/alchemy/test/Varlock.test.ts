import { SecretsError, type SecretsResolver } from "@/Secrets.ts";
import { getStackSecretsEnvironment } from "@/SecretsEnvironment.ts";
import { evalStack, Stack } from "@/Stack.ts";
import * as State from "@/State/index.ts";
import * as TestCore from "@/Test/Core.ts";
import { withProfileOverride } from "@/Auth/Profile.ts";
import { buildStackProviders } from "@/Cli/commands/_shared.ts";
import { execStack } from "@/Cli/commands/deploy.ts";
import { loadStackConfigProvider } from "@/Util/ConfigProvider.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { varlock } from "@/Varlock.ts";
import { makeVarlock, type VarlockRuntime } from "@/VarlockInternal.ts";
import { describe, expect, it, test } from "alchemy-test";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TestLayers } from "./test.resources.ts";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/varlock/${name}`, import.meta.url));

const runConfig = <A>(
  provider: ConfigProvider.ConfigProvider,
  config: Config.Config<A>,
) => Effect.provide(config, ConfigProvider.layer(provider));

describe("Varlock secrets resolver", () => {
  it.effect(
    "loads plain, coerced, composite, imported, required, and sensitive values",
    () =>
      Effect.gen(function* () {
        const resolution = yield* varlock().resolve({
          envFile: fixture("with spaces/.env.schema"),
        });

        const values = yield* Effect.all({
          plain: Config.string("PLAIN"),
          port: Config.number("PORT"),
          token: Config.redacted("TOKEN"),
          imported: Config.string("IMPORTED"),
          required: Config.string("REQUIRED"),
          composite: Config.string("COMPOSITE"),
        }).pipe(Effect.provide(ConfigProvider.layer(resolution.provider)));

        expect(values.plain).toBe("from-varlock");
        expect(values.port).toBe(4242);
        expect(Redacted.value(values.token)).toBe("not-a-real-secret");
        expect(values.imported).toBe("from-import");
        expect(values.required).toBe("present");
        expect(values.composite).toBe('["first","two words"]');
      }),
  );

  it.effect("falls back to ambient values absent from the schema", () =>
    Effect.gen(function* () {
      const resolution = yield* varlock().resolve({
        envFile: fixture("with spaces/.env.schema"),
      });
      expect(resolution.environment.PATH).toBeUndefined();
      expect(yield* runConfig(resolution.provider, Config.string("PATH"))).toBe(
        process.env.PATH,
      );
    }),
  );

  it.effect("gives resolved values precedence over ambient values", () =>
    Effect.gen(function* () {
      const resolver = makeVarlock({
        resolveBin: () => "/installed/varlock/bin/cli.js",
        run: () =>
          JSON.stringify({ config: { PATH: { value: "resolved-path" } } }),
      });
      const resolution = yield* resolver.resolve({});
      expect(yield* runConfig(resolution.provider, Config.string("PATH"))).toBe(
        "resolved-path",
      );
    }),
  );

  it.effect("applies the Alchemy profile override after resolution", () =>
    Effect.gen(function* () {
      const resolver = makeVarlock({
        resolveBin: () => "/installed/varlock/bin/cli.js",
        run: () =>
          JSON.stringify({
            config: {
              ALCHEMY_PROFILE: { value: "from-varlock" },
            },
          }),
      });
      const resolution = yield* resolver.resolve({});
      expect(
        yield* runConfig(
          withProfileOverride(resolution.provider, "from-cli"),
          Config.string("ALCHEMY_PROFILE"),
        ),
      ).toBe("from-cli");
    }),
  );

  it.effect("maps --env-file to a shell-free --path argument", () => {
    const calls: Array<{ bin: string; args: ReadonlyArray<string> }> = [];
    const runtime: VarlockRuntime = {
      resolveBin: () => "/installed/varlock/bin/cli.js",
      run: (bin, args) => {
        calls.push({ bin, args });
        return JSON.stringify({ config: {} });
      },
    };
    const envFile = "/workspace/with spaces/.env.schema";
    return Effect.gen(function* () {
      yield* makeVarlock(runtime).resolve({ envFile });
      expect(calls).toEqual([
        {
          bin: "/installed/varlock/bin/cli.js",
          args: [
            "load",
            "--format",
            "json-full",
            "--compact",
            "--path",
            envFile,
          ],
        },
      ]);
    });
  });

  it.effect(
    "retains the default dotenv loader when no resolver is selected",
    () =>
      Effect.gen(function* () {
        const resolution = yield* loadStackConfigProvider(
          undefined,
          Option.some(fixture("default.env")),
        );
        expect(resolution.environment).toBeUndefined();
        expect(
          yield* runConfig(resolution.provider, Config.string("DOTENV_ONLY")),
        ).toBe("loaded-from-dotenv");
      }).pipe(Effect.provide(PlatformServices)),
  );

  for (const [name, path] of [
    ["invalid schema", "invalid-schema.env.schema"],
    ["missing required value", "invalid-required.env.schema"],
    ["missing plugin", "missing-plugin.env.schema"],
  ] as const) {
    it.effect(`reports a sanitized error for ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* varlock()
          .resolve({ envFile: fixture(path) })
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(SecretsError);
        expect(error.source).toBe("varlock");
        expect(error.exitCode).toBe(1);
        expect(error.message).not.toContain("must-not-appear-in-errors");
      }),
    );
  }

  it.effect("reports a missing optional peer without exposing internals", () =>
    Effect.gen(function* () {
      const error = yield* makeVarlock({
        resolveBin: () => {
          throw new Error("private resolution path");
        },
        run: () => "",
      })
        .resolve({})
        .pipe(Effect.flip);
      expect(error.message).toContain("Varlock is not installed");
      expect(error.message).not.toContain("private resolution path");
    }),
  );

  it.effect(
    "sanitizes malformed stdout that may contain resolved secrets",
    () =>
      Effect.gen(function* () {
        const error = yield* makeVarlock({
          resolveBin: () => "/installed/varlock/bin/cli.js",
          run: () => '{"config":{"TOKEN":{"value":"must-not-leak"}}',
        })
          .resolve({})
          .pipe(Effect.flip);
        expect(error.message).toBe(
          "Varlock returned an invalid configuration payload.",
        );
        expect(error.message).not.toContain("must-not-leak");
      }),
  );
});

test("programmatic stack evaluation resolves once before Config", async () => {
  let calls = 0;
  const resolver: SecretsResolver = {
    resolve: () => {
      calls += 1;
      const environment = {
        STACK_PLUGIN_TOKEN: "resolved-for-stack",
      };
      return Effect.succeed({
        environment,
        provider: ConfigProvider.fromEnv({ env: environment }),
      });
    },
  };
  const stack = Stack(
    "varlock-programmatic",
    {
      providers: TestLayers(),
      state: State.inMemoryState(),
      secrets: resolver,
    },
    Config.string("STACK_PLUGIN_TOKEN"),
  );

  expect(stack.secrets).toBe(resolver);
  await expect(
    TestCore.run(
      evalStack(
        stack,
        (compiled) =>
          Effect.gen(function* () {
            const stackService = yield* Stack;
            return {
              output: compiled.output,
              compiledEnvironment: getStackSecretsEnvironment(compiled),
              sidecarEnvironment: getStackSecretsEnvironment(stackService),
            };
          }),
        { stage: "test" },
      ),
      { providers: TestLayers() },
    ),
  ).resolves.toEqual({
    output: "resolved-for-stack",
    compiledEnvironment: {
      STACK_PLUGIN_TOKEN: "resolved-for-stack",
    },
    sidecarEnvironment: {
      STACK_PLUGIN_TOKEN: "resolved-for-stack",
    },
  });
  expect(calls).toBe(1);
});

test("stack provider authentication sees the resolved environment", async () => {
  const main = fileURLToPath(
    new URL("./Cli/fixtures/varlock-stack-fixture.ts", import.meta.url),
  );
  const result = await TestCore.run(
    buildStackProviders({
      main,
      envFile: Option.none(),
      profile: "default",
    }),
    { providers: TestLayers() },
  );
  const fixtureModule = (await import(pathToFileURL(main).href)) as {
    observedToken: string | undefined;
  };
  expect(result.authProviders.VarlockProbe).toBeDefined();
  expect(fixtureModule.observedToken).toBe("plugin-backed-token");
  expect(result.stackEffect.secrets).toBeDefined();
});

test("CLI deploy resolves once before stack and provider initialization", async () => {
  const main = fileURLToPath(
    new URL("./Cli/fixtures/varlock-stack-fixture.ts", import.meta.url),
  );
  const fixtureModule = (await import(pathToFileURL(main).href)) as {
    observedStackToken: string | undefined;
    observedToken: string | undefined;
    resolverCalls: number;
    resetObservations: () => void;
  };
  fixtureModule.resetObservations();

  await TestCore.run(
    execStack({
      main,
      stage: "test",
      envFile: Option.none(),
      profile: "default",
      dryRun: true,
      yes: true,
    }),
    { providers: TestLayers() },
  );

  expect(fixtureModule.resolverCalls).toBe(1);
  expect(fixtureModule.observedStackToken).toBe("plugin-backed-token");
  expect(fixtureModule.observedToken).toBe("plugin-backed-token");
});
