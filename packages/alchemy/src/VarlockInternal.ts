import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import packageJson from "../package.json" with { type: "json" };
import {
  SecretsError,
  type SecretsResolver,
  type SecretsResolution,
} from "./Secrets.ts";

interface VarlockPackageJson {
  readonly name?: string;
  readonly bin?: string | Record<string, string>;
}

interface SerializedVarlockItem {
  readonly value?: unknown;
  readonly envStr?: string;
  readonly isInternal?: boolean;
}

interface SerializedVarlockGraph {
  readonly config?: Record<string, SerializedVarlockItem>;
}

/** @internal Test seam for Varlock process discovery and execution. */
export interface VarlockRuntime {
  readonly resolveBin: () => string;
  readonly run: (bin: string, args: ReadonlyArray<string>) => string;
}

const findPackage = (entrypoint: string) => {
  let directory = dirname(entrypoint);
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(
          readFileSync(manifestPath, "utf8"),
        ) as VarlockPackageJson;
        if (manifest.name === "varlock") {
          return { directory, manifest };
        }
      } catch {
        // Keep walking: bundled package trees may contain unrelated manifests.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Could not locate the installed varlock package root");
};

const resolveVarlockEntrypoint = () => {
  const cwdRequire = createRequire(
    pathToFileURL(join(process.cwd(), "package.json")),
  );
  try {
    return cwdRequire.resolve("varlock");
  } catch {
    return createRequire(import.meta.url).resolve("varlock");
  }
};

const resolveVarlockBin = () => {
  const { directory, manifest } = findPackage(resolveVarlockEntrypoint());
  const relativeBin =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.varlock;
  if (!relativeBin) {
    throw new Error("The installed varlock package does not declare a CLI");
  }
  return isAbsolute(relativeBin)
    ? relativeBin
    : resolve(directory, relativeBin);
};

const environmentString = (
  key: string,
  item: SerializedVarlockItem,
): string | undefined => {
  if (item.isInternal || item.value === undefined) return undefined;
  if (item.envStr !== undefined) return item.envStr;
  if (
    typeof item.value === "string" ||
    typeof item.value === "number" ||
    typeof item.value === "boolean" ||
    item.value === null
  ) {
    return String(item.value);
  }
  throw new Error(
    `Varlock did not provide an environment string for composite item ${JSON.stringify(key)}`,
  );
};

const parseEnvironment = (stdout: string): Record<string, string> => {
  let graph: SerializedVarlockGraph;
  try {
    graph = JSON.parse(stdout) as SerializedVarlockGraph;
  } catch {
    throw new Error("Varlock returned malformed JSON");
  }
  if (!graph.config || typeof graph.config !== "object") {
    throw new Error("Varlock returned JSON without a config object");
  }
  const environment: Record<string, string> = {};
  for (const [key, item] of Object.entries(graph.config)) {
    if (!item || typeof item !== "object") {
      throw new Error("Varlock returned an invalid config item");
    }
    const value = environmentString(key, item);
    if (value !== undefined) environment[key] = value;
  }
  return environment;
};

const defaultRuntime: VarlockRuntime = {
  resolveBin: resolveVarlockBin,
  run: (bin, args) => {
    try {
      return execFileSync(process.execPath, [bin, ...args], {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          __VARLOCK_INTEGRATION: `alchemy@${packageJson.version}`,
        },
        stdio: ["inherit", "pipe", "pipe"],
      });
    } catch (error) {
      const result = error as {
        readonly status?: number;
        readonly stderr?: Buffer | string;
      };
      const stderr = result.stderr?.toString().trim();
      throw new SecretsError({
        source: "varlock",
        message:
          stderr && stderr.length > 0
            ? stderr
            : "Varlock failed to resolve the configured environment.",
        ...(result.status === undefined ? {} : { exitCode: result.status }),
      });
    }
  },
};

const loadVarlock = (
  runtime: VarlockRuntime,
  envFile?: string,
): SecretsResolution => {
  let bin: string;
  try {
    bin = runtime.resolveBin();
  } catch {
    throw new SecretsError({
      source: "varlock",
      message:
        "Varlock is not installed. Add `varlock` to your application's dependencies before using `secrets: varlock()`.",
    });
  }

  const args = ["load", "--format", "json-full", "--compact"];
  if (envFile !== undefined) args.push("--path", envFile);

  let stdout: string;
  try {
    stdout = runtime.run(bin, args);
  } catch (error) {
    throw error instanceof SecretsError
      ? error
      : new SecretsError({
          source: "varlock",
          message: "Varlock failed to resolve the configured environment.",
        });
  }

  let environment: Record<string, string>;
  try {
    environment = parseEnvironment(stdout);
  } catch {
    throw new SecretsError({
      source: "varlock",
      message: "Varlock returned an invalid configuration payload.",
    });
  }

  return {
    environment,
    provider: ConfigProvider.orElse(
      ConfigProvider.fromEnv({ env: environment }),
      ConfigProvider.fromEnv(),
    ),
  };
};

/** @internal */
export const makeVarlock = (
  runtime: VarlockRuntime = defaultRuntime,
): SecretsResolver => ({
  resolve: ({ envFile }) =>
    Effect.try({
      try: () => loadVarlock(runtime, envFile),
      catch: (error) =>
        error instanceof SecretsError
          ? error
          : new SecretsError({
              source: "varlock",
              message: "Varlock failed to resolve the configured environment.",
            }),
    }),
});
