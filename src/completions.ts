export class CompletionsError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'CompletionsError';
	}
}

export interface StreamCompletionsOptions {
	readonly proxy: string;
	readonly model: string;
	readonly token: string;
	readonly prompt: string;
	readonly suffix: string;
	readonly languageId: string;
	readonly maxTokens: number;
	readonly signal?: AbortSignal;
	/** Extra headers (editor/session identifiers etc.) merged into the request. */
	readonly extraHeaders?: Record<string, string>;
}

/**
 * Streams raw completion text from the Copilot fill-in-the-middle endpoint
 * (`{proxy}/v1/engines/{model}/completions`) over SSE.
 */
export async function* streamCompletions(opts: StreamCompletionsOptions): AsyncGenerator<string> {
	const url = `${opts.proxy}/v1/engines/${encodeURIComponent(opts.model)}/completions`;

	const res = await fetch(url, {
		method: 'POST',
		headers: {
			...opts.extraHeaders,
			Authorization: `Bearer ${opts.token}`,
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
			'Openai-Organization': 'github-copilot',
			'OpenAI-Intent': 'copilot-ghost',
			'User-Agent': 'GitHubCopilotChat/0.61.0',
			'X-GitHub-Api-Version': '2025-05-01',
		},
		body: JSON.stringify({
			prompt: opts.prompt,
			suffix: opts.suffix,
			max_tokens: opts.maxTokens,
			temperature: 0,
			top_p: 1,
			n: 1,
			stop: ['\n\n\n'],
			stream: true,
			extra: { language: opts.languageId },
		}),
		signal: opts.signal,
	});

	if (!res.ok || !res.body) {
		const detail = await res.text().catch(() => '');
		throw new CompletionsError(res.status, describeStatus(res.status, detail));
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		const { value, done } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });

		let newlineIndex: number;
		while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);

			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (data === '[DONE]') return;

			try {
				const chunk = JSON.parse(data) as { choices?: Array<{ text?: string }> };
				const text = chunk.choices?.[0]?.text;
				if (text) yield text;
			} catch {
				// Ignore partial / non-JSON SSE payloads.
			}
		}

		if (done) return;
	}
}

function describeStatus(status: number, detail: string): string {
	switch (status) {
		case 401:
		case 403:
			return `Copilot token invalid or expired (${status})`;
		case 402:
			return `Copilot completions quota exceeded (${status})`;
		case 429:
			return `Copilot rate limited (${status})`;
		case 466:
			return `Copilot client not supported (${status})`;
		default:
			return `Completions request failed (${status}): ${detail.slice(0, 200)}`;
	}
}
