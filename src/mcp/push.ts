import * as vscode from 'vscode';
import { log } from '../log';
import type { InProcHttpServer } from './server';
import { getSelectionInfo, SelectionState } from './tools';

/** Debounces a callback; trailing edge only (mirrors the official Delayer). */
class Debouncer {
	private handle: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly delayMs: number) {}

	trigger(fn: () => void): void {
		clearTimeout(this.handle);
		this.handle = setTimeout(fn, this.delayMs);
	}

	dispose(): void {
		clearTimeout(this.handle);
	}
}

/**
 * Broadcasts `selection_changed` (200ms debounced) to every connected client
 * and keeps the latest selection cached for `get_selection`.
 */
export function registerSelectionChangedNotification(
	httpServer: InProcHttpServer,
	selectionState: SelectionState,
): vscode.Disposable[] {
	const debouncer = new Debouncer(200);
	const disposable = vscode.window.onDidChangeTextEditorSelection((event) => {
		debouncer.trigger(() => {
			const info = getSelectionInfo(event.textEditor);
			selectionState.update(info);
			httpServer.broadcastNotification('selection_changed', info as unknown as Record<string, unknown>);
		});
	});

	// Seed the cache with the current selection, if any.
	if (vscode.window.activeTextEditor) {
		selectionState.update(getSelectionInfo(vscode.window.activeTextEditor));
	}

	return [disposable, debouncer];
}

interface DiagnosticInfo {
	uri: string;
	diagnostics: Array<{
		range: {
			start: { line: number; character: number };
			end: { line: number; character: number };
		};
		message: string;
		severity: string;
		source?: string;
		code?: string | number;
	}>;
}

function severityToString(severity: vscode.DiagnosticSeverity): string {
	switch (severity) {
		case vscode.DiagnosticSeverity.Error:
			return 'error';
		case vscode.DiagnosticSeverity.Warning:
			return 'warning';
		case vscode.DiagnosticSeverity.Information:
			return 'information';
		case vscode.DiagnosticSeverity.Hint:
			return 'hint';
		default:
			return 'unknown';
	}
}

function getDiagnosticsForUri(uri: vscode.Uri): DiagnosticInfo {
	return {
		uri: uri.toString(),
		diagnostics: vscode.languages.getDiagnostics(uri).map((d) => ({
			range: {
				start: { line: d.range.start.line, character: d.range.start.character },
				end: { line: d.range.end.line, character: d.range.end.character },
			},
			message: d.message,
			severity: severityToString(d.severity),
			source: d.source,
			code: typeof d.code === 'object' ? d.code.value : d.code,
		})),
	};
}

/** Broadcasts `diagnostics_changed` (200ms debounced) for changed URIs. */
export function registerDiagnosticsChangedNotification(httpServer: InProcHttpServer): vscode.Disposable[] {
	const debouncer = new Debouncer(200);
	const disposable = vscode.languages.onDidChangeDiagnostics((event) => {
		debouncer.trigger(() => {
			httpServer.broadcastNotification('diagnostics_changed', {
				uris: event.uris.map((uri) => getDiagnosticsForUri(uri)),
			} as unknown as Record<string, unknown>);
		});
	});
	return [disposable, debouncer];
}

/** Registers both push notifications. */
export function registerPushNotifications(httpServer: InProcHttpServer, selectionState: SelectionState): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];
	for (const d of registerSelectionChangedNotification(httpServer, selectionState)) {
		disposables.push(d);
	}
	for (const d of registerDiagnosticsChangedNotification(httpServer)) {
		disposables.push(d);
	}
	log('push notifications registered (selection_changed / diagnostics_changed)');
	return disposables;
}
