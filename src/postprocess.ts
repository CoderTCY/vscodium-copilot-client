/**
 * Minimal post-processing for a raw completion stream.
 * Returns the final text to insert, or undefined to reject the suggestion.
 */
export function postProcess(raw: string, fullPrefix: string): string | undefined {
	let text = raw.replace(/\s+$/u, '');

	if (!text) return undefined;

	// The model often re-emits the text that is already after the cursor;
	// drop the part duplicating the current line before the cursor.
	const cursorLine = fullPrefix.slice(fullPrefix.lastIndexOf('\n') + 1);
	if (cursorLine && text.startsWith(cursorLine)) {
		text = text.slice(cursorLine.length);
	}

	return text || undefined;
}
