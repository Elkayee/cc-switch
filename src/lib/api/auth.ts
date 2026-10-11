import { invoke } from "@tauri-apps/api/core";

export type ManagedAuthProvider =
  "github_copilot" | "codex_oauth" | "xai_oauth";

export const CODEX_OAUTH_DUPLICATE_ACCOUNT_ERROR =
  "codex_oauth_duplicate_account";

export interface ManagedAuthAccount {
  id: string;
  provider: ManagedAuthProvider;
  login: string;
  avatar_url: string | null;
  authenticated_at: number;
  is_default: boolean;
  github_domain: string;
  /** Codex-only: the account lacks identity or workspace metadata required for binding. */
  reauth_required?: boolean;
  /** xAI-only: the refresh credential is invalid and the account is unusable. */
  requires_reauth: boolean;
}

export interface ManagedAuthStatus {
  provider: ManagedAuthProvider;
  authenticated: boolean;
  default_account_id: string | null;
  migration_error?: string | null;
  accounts: ManagedAuthAccount[];
}

/** Access token of a managed OAuth provider (xAI, ChatGPT, Copilot), as served to direct-connect clients. */
export interface ProviderDirectToken {
  access_token: string;
  token_type: string;
  auth_provider: ManagedAuthProvider;
  /** Full URL a direct client POSTs to. */
  endpoint: string;
  /** Headers the upstream needs besides `Authorization: Bearer <token>`. */
  headers: { name: string; value: string }[];
  /** Unix ms. */
  expires_at: number | null;
  expires_in: number | null;
  refreshed: boolean;
  retry_after: number | null;
  account_id: string;
}

export interface ManagedAuthDeviceCodeResponse {
  provider: ManagedAuthProvider;
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function authStartLogin(
  authProvider: ManagedAuthProvider,
  githubDomain?: string,
  targetAccountId?: string,
): Promise<ManagedAuthDeviceCodeResponse> {
  return invoke<ManagedAuthDeviceCodeResponse>("auth_start_login", {
    authProvider,
    githubDomain: githubDomain || null,
    targetAccountId: targetAccountId || null,
  });
}

export async function authPollForAccount(
  authProvider: ManagedAuthProvider,
  deviceCode: string,
  githubDomain?: string,
): Promise<ManagedAuthAccount | null> {
  return invoke<ManagedAuthAccount | null>("auth_poll_for_account", {
    authProvider,
    deviceCode,
    githubDomain: githubDomain || null,
  });
}

export async function authCancelLogin(
  authProvider: ManagedAuthProvider,
  deviceCode: string,
): Promise<boolean> {
  return invoke<boolean>("auth_cancel_login", {
    authProvider,
    deviceCode,
  });
}

export async function authListAccounts(
  authProvider: ManagedAuthProvider,
): Promise<ManagedAuthAccount[]> {
  return invoke<ManagedAuthAccount[]>("auth_list_accounts", {
    authProvider,
  });
}

export async function authGetStatus(
  authProvider: ManagedAuthProvider,
): Promise<ManagedAuthStatus> {
  return invoke<ManagedAuthStatus>("auth_get_status", {
    authProvider,
  });
}

export async function authRemoveAccount(
  authProvider: ManagedAuthProvider,
  accountId: string,
): Promise<void> {
  return invoke("auth_remove_account", {
    authProvider,
    accountId,
  });
}

export async function authSetDefaultAccount(
  authProvider: ManagedAuthProvider,
  accountId: string,
): Promise<void> {
  return invoke("auth_set_default_account", {
    authProvider,
    accountId,
  });
}

export async function authLogout(
  authProvider: ManagedAuthProvider,
): Promise<void> {
  return invoke("auth_logout", {
    authProvider,
  });
}

/** Current token; reports no rejection, so only a token with under an hour left is renewed. */
export async function getProviderDirectToken(
  app: string,
  providerId: string,
): Promise<ProviderDirectToken> {
  return invoke<ProviderDirectToken>("get_provider_direct_token", {
    app,
    providerId,
  });
}

export const authApi = {
  getProviderDirectToken,
  authStartLogin,
  authPollForAccount,
  authCancelLogin,
  authListAccounts,
  authGetStatus,
  authRemoveAccount,
  authSetDefaultAccount,
  authLogout,
};
