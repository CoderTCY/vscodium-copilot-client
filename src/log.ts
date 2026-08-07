import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel('VSCodium Copilot Client');
	}
	return channel;
}

/** Appends a line to the "VSCodium Copilot Client" output channel. */
export function log(message: string): void {
	getChannel().appendLine(message);
}

/** Reveals the "VSCodium Copilot Client" output channel in the Output panel. */
export function showLog(): void {
	getChannel().show(true);
}
