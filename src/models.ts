import * as vscode from 'vscode';
import type { CopilotAccess } from './token';

/**
 * CAPI endpoint that lists models. Completion models are filtered by
 * capability type.
 */
const MODELS_URL = 'https://api.githubcopilot.com/models';
// The /models endpoint uses its own API version (see networking.ts in the
// official extension — every endpoint has its own versioning).
const MODELS_API_VERSION = '2026-01-09';

interface CachedModels {
	models: string[];
	fetchedAt: number;
}

let cache: CachedModels | undefined;

/**
 * Returns the ids of all models that support code completion
 * (capability type `completion`), fetched once per 5 minutes.
 */
export async function getCompletionModelIds(access: CopilotAccess): Promise<string[]> {
	if (cache && Date.now() - cache.fetchedAt < 5 * 60_000) {
		return cache.models;
	}

	const res = await fetch(MODELS_URL, {
		headers: {
			Authorization: `Bearer ${access.token}`,
			Accept: 'application/json',
			// The CAPI models endpoint expects the same headers the official
			// client sends (see networkRequest + capiClient in the extension).
			'Copilot-Integration-Id': 'code-oss',
			'OpenAI-Intent': 'model-access',
			'X-Interaction-Type': 'model-access',
			'X-Request-Id': crypto.randomUUID(),
			'VScode-SessionId': vscode.env.sessionId,
			'VScode-MachineId': vscode.env.machineId,
			'X-GitHub-Api-Version': MODELS_API_VERSION,
		},
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`Model list request failed (${res.status}): ${detail.slice(0, 300)}`);
	}

	const body = (await res.json()) as {
		data?: Array<{ id: string; capabilities?: { type?: string } }>;
	};

	const models = (body.data ?? [])
		.filter((m) => m.capabilities?.type === 'completion')
		.map((m) => m.id);

	if (models.length > 0) {
		cache = { models, fetchedAt: Date.now() };
	}

	return models;
}