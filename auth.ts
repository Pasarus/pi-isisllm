// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones
/**
 * Authentication for the `isisllm` provider.
 *
 * `resolve()` prefers the environment variable and falls back to the credential pi stored from
 * `/login`; `login()` asks for the key through pi's masked secret prompt and returns an
 * `api_key` credential, which pi persists in `~/.pi/agent/auth.json`. The extension never writes
 * a credential store and never prints a key — only the *source* label is ever surfaced.
 */

import type {
  ApiKeyAuth,
  ApiKeyCredential,
  AuthResult,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import type { IsisllmConfig } from "./types.js";
import { PROVIDER_NAME } from "./types.js";

/** `source` label reported when the key came from the environment. */
export function envSourceLabel(config: Pick<IsisllmConfig, "apiKeyEnv">): string {
  return config.apiKeyEnv;
}

/** `source` label reported when the key came from `/login`. */
export const STORED_SOURCE_LABEL = "stored credential";

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * The provider's `auth` block. `check()` exists so availability questions (does this provider
 * have a key?) never depend on ambient shell state beyond the env var and the stored credential.
 */
export function createApiKeyAuth(config: Pick<IsisllmConfig, "apiKeyEnv">): ApiKeyAuth {
  return {
    name: `${PROVIDER_NAME} API key`,

    async login(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
      const entered = await interaction.prompt({
        type: "secret",
        message: `Paste your ${PROVIDER_NAME} API key`,
        placeholder: "sk-...",
      });
      const key = firstNonEmpty(entered);
      if (!key) throw new Error(`No ${PROVIDER_NAME} API key entered.`);
      return { type: "api_key", key };
    },

    async resolve({ ctx, credential }): Promise<AuthResult | undefined> {
      const fromEnv = firstNonEmpty(await ctx.env(config.apiKeyEnv));
      const fromStore = firstNonEmpty(credential?.key);
      const apiKey = fromEnv ?? fromStore;
      if (!apiKey) return undefined;
      return {
        auth: { apiKey },
        source: fromEnv ? envSourceLabel(config) : STORED_SOURCE_LABEL,
      };
    },

    async check({ ctx, credential }) {
      const fromEnv = firstNonEmpty(await ctx.env(config.apiKeyEnv));
      const fromStore = firstNonEmpty(credential?.key);
      if (!fromEnv && !fromStore) return undefined;
      return { type: "api_key", source: fromEnv ? envSourceLabel(config) : STORED_SOURCE_LABEL };
    },
  };
}

/** Whether a key exists in the environment, without exposing it. */
export function hasEnvApiKey(
  config: Pick<IsisllmConfig, "apiKeyEnv">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return firstNonEmpty(env[config.apiKeyEnv]) !== undefined;
}
