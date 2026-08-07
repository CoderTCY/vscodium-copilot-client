/**
 * Rough token budget for truncation. A real tokenizer (e.g. o200k) is more
 * accurate, but 3.5 chars/token is a good enough heuristic for prompts.
 */
const CHARS_PER_TOKEN = 3.5;

/** Keeps the END of the text (most recent context before the cursor). */
export function truncatePrefix(text: string, tokens: number): string {
	const chars = Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
	return text.length <= chars ? text : text.slice(text.length - chars);
}

/** Keeps the BEGINNING of the text (context after the cursor). */
export function truncateSuffix(text: string, tokens: number): string {
	const chars = Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
	return text.length <= chars ? text : text.slice(0, chars);
}
