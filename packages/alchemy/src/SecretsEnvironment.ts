import * as Context from "effect/Context";

/** Resolved values forwarded to out-of-process local providers. */
export class SecretsEnvironment extends Context.Service<
  SecretsEnvironment,
  Readonly<Record<string, string>>
>()("alchemy/SecretsEnvironment") {}

const stackEnvironments = new WeakMap<
  object,
  Readonly<Record<string, string>>
>();

export const setStackSecretsEnvironment = (
  stack: object,
  environment: Readonly<Record<string, string>>,
) => {
  stackEnvironments.set(stack, environment);
};

export const getStackSecretsEnvironment = (stack: object) =>
  stackEnvironments.get(stack);
