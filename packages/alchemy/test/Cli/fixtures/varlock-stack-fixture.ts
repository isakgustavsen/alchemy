import {
  AuthProviderLayer,
  type AuthProviderImpl,
} from "@/Auth/AuthProvider.ts";
import type { SecretsResolver } from "@/Secrets.ts";
import { Stack } from "@/Stack.ts";
import * as State from "@/State/index.ts";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

type ProbeConfig = { method: "env" };
type ProbeCredentials = { token: string };

export let observedToken: string | undefined;
export let observedStackToken: string | undefined;
export let resolverCalls = 0;

export const resetObservations = () => {
  observedToken = undefined;
  observedStackToken = undefined;
  resolverCalls = 0;
};

export const resolver: SecretsResolver = {
  resolve: () => {
    resolverCalls += 1;
    const environment = { VARLOCK_AUTH_TOKEN: "plugin-backed-token" };
    return Effect.succeed({
      environment,
      provider: ConfigProvider.fromEnv({ env: environment }),
    });
  },
};

const ProbeAuth = AuthProviderLayer<ProbeConfig, ProbeCredentials>()(
  "VarlockProbe",
  Effect.gen(function* () {
    const token = yield* Config.string("VARLOCK_AUTH_TOKEN").pipe(Effect.orDie);
    observedToken = token;
    return {
      configure: () => Effect.succeed({ method: "env" as const }),
      login: () => Effect.void,
      logout: () => Effect.void,
      prettyPrint: () => Effect.void,
      read: () => Effect.succeed({ token }),
    } satisfies AuthProviderImpl<ProbeConfig, ProbeCredentials>;
  }),
);

export default Stack(
  "varlock-auth-fixture",
  {
    providers: ProbeAuth,
    state: State.inMemoryState(),
    secrets: resolver,
  },
  Effect.gen(function* () {
    observedStackToken = yield* Config.string("VARLOCK_AUTH_TOKEN");
  }),
);
