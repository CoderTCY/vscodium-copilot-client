import * as vscode from 'vscode';

/**
 * GitHub Copilot's entitlements endpoint. Mirrors the VS Code default in
 * product.json (`defaultChatAgent.entitlementUrl`). Not a public API — subject
 * to change.
 */
const ENTITLEMENTS_URL = 'https://api.github.com/copilot_internal/user';

/** Quota data is cached this long before being refetched (ms). */
const CACHE_TTL_MS = 10 * 60_000;

/** Parsed completions quota for the current GitHub account. */
export interface CompletionQuota {
	/** 0..100 — percentage of the completions allowance remaining. */
	readonly percentRemaining: number;
	/** True when the plan has no completions quota (e.g. Pro). */
	readonly unlimited: boolean;
	/** Total allowed completions (when the plan reports one). */
	readonly entitlement?: number;
	/** Completions still available. */
	readonly remaining?: number;
	/** Completions already used. */
	readonly used?: number;
	/** When the quota resets (ISO string) — absent when unknown. */
	readonly resetDate?: string;
	/** Copilot plan id, e.g. `free_limited_copilot`, `individual`. */
	readonly plan?: string;
}

interface EntitlementsData {
	readonly copilot_plan?: string;
	readonly quota_reset_date_utc?: string;
	readonly quota_reset_date?: string;
	readonly limited_user_reset_date?: string;
	readonly monthly_quotas?: { chat?: number; completions?: number };
	readonly limited_user_quotas?: { chat?: number; completions?: number };
	readonly quota_snapshots?: {
		chat?: QuotaSnapshotData;
		completions?: QuotaSnapshotData;
		premium_interactions?: QuotaSnapshotData;
	};
}

interface QuotaSnapshotData {
	readonly percent_remaining?: number;
	readonly unlimited?: boolean;
	readonly entitlement?: string | number;
	readonly quota_remaining?: number;
	readonly credits_used?: number;
}

let cache: { value: CompletionQuota; expiresAt: number } | undefined;

/**
 * Fetches the current GitHub Copilot completions quota, or undefined when the
 * account has no completions quota to report (e.g. an unlimited plan).
 */
export async function getCompletionQuota(force = false): Promise<CompletionQuota | undefined> {
	if (!force && cache && Date.now() < cache.expiresAt) {
		return cache.value;
	}

	const session = await vscode.authentication.getSession('github', ['user:email', 'read:user'], {
		createIfNone: false,
	});
	if (!session) {
		return undefined;
	}

	const res = await fetch(ENTITLEMENTS_URL, {
		headers: {
			Authorization: `Bearer ${session.accessToken}`,
			Accept: 'application/json',
			'X-GitHub-Api-Version': '2025-05-01',
		},
	});

	// 401/404 mean the token cannot read entitlements — treat as "no quota info".
	if (res.status === 401 || res.status === 404) {
		return undefined;
	}
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`Copilot entitlements request failed (${res.status}): ${detail.slice(0, 200)}`);
	}

	const data = (await res.json()) as EntitlementsData;
	const quota = parseCompletionQuota(data);
	if (quota) {
		cache = { value: quota, expiresAt: Date.now() + CACHE_TTL_MS };
	}
	return quota;
}

/**
 * Parses the completions quota out of an entitlements payload.
 * Returns undefined when the payload carries no completions quota.
 * Exported for unit tests.
 */
export function parseCompletionQuota(data: EntitlementsData): CompletionQuota | undefined {
	const plan = data.copilot_plan;
	const resetDate = data.quota_reset_date_utc ?? data.quota_reset_date ?? data.limited_user_reset_date;

	// New quota snapshot (Copilot Free / usage-based billing plans).
	const snapshot = data.quota_snapshots?.completions;
	if (snapshot) {
		const entitlement = toNumber(snapshot.entitlement);
		// No allocated entitlement for this category — nothing to display.
		if (!snapshot.unlimited && entitlement === 0) {
			return undefined;
		}
		return {
			percentRemaining: clampPercent(snapshot.percent_remaining),
			unlimited: Boolean(snapshot.unlimited),
			entitlement,
			remaining: toNumber(snapshot.quota_remaining),
			used: toNumber(snapshot.credits_used),
			resetDate,
			plan,
		};
	}

	// Legacy Copilot Free quota: limited_user_quotas / monthly_quotas.
	const monthly = data.monthly_quotas?.completions;
	const limited = data.limited_user_quotas?.completions;
	if (monthly && typeof limited === 'number') {
		return {
			percentRemaining: clampPercent((limited / monthly) * 100),
			unlimited: false,
			entitlement: monthly,
			remaining: limited,
			used: monthly - limited,
			resetDate,
			plan,
		};
	}

	return undefined;
}

function toNumber(value: unknown): number | undefined {
	const n = typeof value === 'string' ? Number(value) : value;
	return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function clampPercent(value: unknown): number {
	const n = typeof value === 'number' ? value : 0;
	return Math.min(100, Math.max(0, n));
}
