import * as vscode from 'vscode';

/**
 * GitHub Copilot's private token endpoint. Not a public API — subject to change.
 */
const TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

export interface CopilotAccess {
	/** The Copilot API token (distinct from the GitHub OAuth token). */
	readonly token: string;
	/** Base URL for the FIM completion proxy, taken from the token's `endpoints`. */
	readonly proxy: string;
}

interface TokenCache {
	value: CopilotAccess;
	expiresAt: number;
}

let cache: TokenCache | undefined;

/**
 * Returns the current Copilot access (token + proxy base URL), refreshing it
 * whenever the token is close to expiry. Pass `force = true` to drop the cache
 * and prompt for a fresh GitHub sign-in (used by the status-bar sign-in entry).
 */
export async function getCopilotAccess(force = false): Promise<CopilotAccess> {
	if (!force && cache && Date.now() < cache.expiresAt - 60_000) {
		return cache.value;
	}

	// `createIfNone` and `forceNewSession` cannot be combined: VS Code rejects the
	// request with "Invalid combination of options". For a plain lookup/sign-in use
	// createIfNone; for a forced re-auth, forceNewSession alone prompts sign-in too.
	const options = force
		? { forceNewSession: { detail: 'Re-authenticate VSCodium Copilot Client' } as const }
		: { createIfNone: true as const };
	const githubSession = await vscode.authentication.getSession('github', ['user:email', 'read:user'], options);
	if (!githubSession) {
		throw new Error('no GitHub session — sign-in cancelled');
	}

	const res = await fetch(TOKEN_URL, {
		headers: {
			Authorization: `Bearer ${githubSession.accessToken}`,
			Accept: 'application/json',
			'X-GitHub-Api-Version': '2025-05-01',
		},
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`Copilot token request failed (${res.status}): ${detail.slice(0, 200)}`);
	}

	const body = (await res.json()) as {
		token?: string;
		expires_at?: string;
		endpoints?: { proxy?: string; 'origin-tracker'?: string };
	};

	if (!body.token) {
		throw new Error('The token endpoint returned no token. Do you have a GitHub Copilot subscription?');
	}

	const access: CopilotAccess = {
		token: body.token,
		proxy: body.endpoints?.proxy ?? 'https://copilot-proxy.githubusercontent.com',
	};

	cache = {
		value: access,
		expiresAt: body.expires_at ? Date.parse(body.expires_at) : Number.POSITIVE_INFINITY,
	};

	return access;
}

/**
 * Drops the cached token and immediately re-authenticates, so the next
 * completion request uses a fresh token.
 */
export async function resetCopilotAccess(): Promise<void> {
	cache = undefined;
	await getCopilotAccess();
}
