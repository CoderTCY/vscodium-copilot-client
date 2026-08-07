import * as vscode from 'vscode';

/**
 * Custom URI scheme for the read-only virtual documents backing a CLI diff.
 * Both sides of the diff are provided from in-memory content, so the CLI never
 * writes files — it only asks us to display the comparison and report the
 * user's choice.
 */
export const READONLY_SCHEME = 'vscodium-copilot-cli';

export class ReadonlyContentProvider implements vscode.TextDocumentContentProvider {
	private readonly contentStore = new Map<string, string>();

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contentStore.get(uri.toString()) ?? '';
	}

	setContent(uri: vscode.Uri, content: string): void {
		this.contentStore.set(uri.toString(), content);
	}

	clearContent(uri: vscode.Uri): void {
		this.contentStore.delete(uri.toString());
	}

	register(): vscode.Disposable {
		return vscode.workspace.registerTextDocumentContentProvider(READONLY_SCHEME, this);
	}
}

/**
 * Builds a readonly URI for one side of a diff. `suffix` (unique per diff) is
 * carried in the query so each diff gets its own distinct document.
 */
export function createReadonlyUri(originalPath: string, suffix: string): vscode.Uri {
	const fileUri = vscode.Uri.file(originalPath);
	return vscode.Uri.from({
		scheme: READONLY_SCHEME,
		path: fileUri.path,
		query: suffix,
	});
}
