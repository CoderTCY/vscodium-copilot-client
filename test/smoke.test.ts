import { afterAll, expect, mock, test } from 'bun:test';
import { CompletionsError, streamCompletions } from '../src/completions';
import { postProcess } from '../src/postprocess';
import { truncatePrefix, truncateSuffix } from '../src/truncate';

// ---- completions.ts: SSE parsing against a local server ----

const stoppers: Array<() => void> = [];
afterAll(() => {
	for (const stop of stoppers) stop();
});

test('streamCompletions parses SSE chunks into text', async () => {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			if (req.method === 'POST' && new URL(req.url).pathname === '/v1/engines/gpt-test/completions') {
				return new Response(
					'data: {"choices":[{"text":"hel"}]}\n\n' +
					'data: {"choices":[{"text":"lo, "}]}\n\n' +
					'data: {"choices":[{"text":"world"}]}\n\n' +
					'data: [DONE]\n\n',
					{ headers: { 'Content-Type': 'text/event-stream' } },
				);
			}
			return new Response('not found', { status: 404 });
		},
	});
	stoppers.push(() => server.stop());

	let text = '';
	for await (const chunk of streamCompletions({
		proxy: `http://127.0.0.1:${server.port}`,
		model: 'gpt-test',
		token: 'fake',
		prompt: 'function foo() {',
		suffix: '}',
		languageId: 'typescript',
		maxTokens: 64,
	})) {
		text += chunk;
	}
	expect(text).toBe('hello, world');
});

test('streamCompletions surfaces HTTP errors', async () => {
	const server = Bun.serve({
		port: 0,
		fetch() {
			return new Response('rate limited', { status: 429 });
		},
	});
	stoppers.push(() => server.stop());

	let error: unknown;
	try {
		for await (const _ of streamCompletions({
			proxy: `http://127.0.0.1:${server.port}`,
			model: 'm',
			token: 't',
			prompt: 'p',
			suffix: 's',
			languageId: 'ts',
			maxTokens: 8,
		})) {
			// Not expected to reach here.
		}
	} catch (err) {
		error = err;
	}

	expect(error).toBeInstanceOf(CompletionsError);
	expect((error as CompletionsError).status).toBe(429);
	expect((error as CompletionsError).message).toContain('rate limited');
});

// ---- truncate.ts ----

test('truncatePrefix keeps the END of the text', () => {
	expect(truncatePrefix('abcdefghij', 1)).toBe('hij'); // 1 token ≈ 3.5 chars
	expect(truncatePrefix('short', 100)).toBe('short');
});

test('truncateSuffix keeps the BEGINNING of the text', () => {
	expect(truncateSuffix('abcdefghij', 1)).toBe('abc');
	expect(truncateSuffix('short', 100)).toBe('short');
});

// ---- postprocess.ts ----

test('postProcess trims trailing whitespace', () => {
	expect(postProcess('hello world\n  ', 'foo\n')).toBe('hello world');
});

test('postProcess strips the duplicated cursor line', () => {
	expect(postProcess('const x = 1;\nconst x = ', 'const x = ')).toBe('1;\nconst x =');
});

test('postProcess rejects empty completions', () => {
	expect(postProcess('   ', 'foo')).toBeUndefined();
	expect(postProcess('', 'foo')).toBeUndefined();
});

// ---- quota.ts + token.ts: parsing with mocked vscode + fetch ----

mock.module('vscode', () => ({
	authentication: {
		getSession: async () => ({ accessToken: 'fake-oauth' }),
	},
}));

const { getCompletionQuota, parseCompletionQuota } = await import('../src/quota');
const { getCopilotAccess } = await import('../src/token');

test('parseCompletionQuota parses the new quota snapshot', () => {
	const quota = parseCompletionQuota({
		copilot_plan: 'free_limited_copilot',
		quota_reset_date_utc: '2026-09-01T00:00:00Z',
		quota_snapshots: {
			completions: {
				percent_remaining: 42.5,
				unlimited: false,
				entitlement: '2000',
				quota_remaining: 850,
				credits_used: 1150,
			},
		},
	});

	expect(quota).toMatchObject({
		percentRemaining: 42.5,
		unlimited: false,
		entitlement: 2000,
		remaining: 850,
		used: 1150,
		resetDate: '2026-09-01T00:00:00Z',
		plan: 'free_limited_copilot',
	});
});

test('parseCompletionQuota reports an unlimited snapshot', () => {
	const quota = parseCompletionQuota({
		copilot_plan: 'individual',
		quota_snapshots: { completions: { percent_remaining: 100, unlimited: true } },
	});
	expect(quota).toMatchObject({ unlimited: true, percentRemaining: 100 });
});

test('parseCompletionQuota skips snapshots without an allocated entitlement', () => {
	expect(
		parseCompletionQuota({
			copilot_plan: 'individual',
			quota_snapshots: { completions: { percent_remaining: 0, unlimited: false, entitlement: '0' } },
		}),
	).toBeUndefined();
});

test('parseCompletionQuota falls back to the legacy free quota', () => {
	const quota = parseCompletionQuota({
		copilot_plan: 'free_limited_copilot',
		limited_user_reset_date: '2026-09-01',
		monthly_quotas: { chat: 100, completions: 50 },
		limited_user_quotas: { chat: 100, completions: 25 },
	});

	expect(quota).toMatchObject({
		percentRemaining: 50,
		unlimited: false,
		entitlement: 50,
		remaining: 25,
		used: 25,
		resetDate: '2026-09-01',
	});
});

test('parseCompletionQuota returns undefined without a completions quota', () => {
	expect(parseCompletionQuota({ copilot_plan: 'individual', quota_snapshots: { chat: { percent_remaining: 10, unlimited: false } } })).toBeUndefined();
});

test('getCompletionQuota fetches and caches the entitlements payload', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				copilot_plan: 'free_limited_copilot',
				quota_snapshots: {
					completions: { percent_remaining: 30, unlimited: false, entitlement: '100', quota_remaining: 30 },
				},
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		);

	try {
		const quota = await getCompletionQuota(true);
		expect(quota).toMatchObject({ percentRemaining: 30, remaining: 30, entitlement: 100 });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('getCopilotAccess parses the token response and endpoint proxy', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				token: 'copilot-token-123',
				expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				endpoints: { proxy: 'https://proxy.example.com' },
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		);

	try {
		const access = await getCopilotAccess();
		expect(access.token).toBe('copilot-token-123');
		expect(access.proxy).toBe('https://proxy.example.com');
	} finally {
		globalThis.fetch = originalFetch;
	}
});
