import * as vscode from 'vscode';
import { log } from '../log';
import { cleanupStaleLockFiles, createLockFile } from './lockFile';
import { DiffStateManager } from './diffState';
import { InProcHttpServer } from './server';
import { ReadonlyContentProvider, READONLY_SCHEME } from './readonlyContentProvider';
import { registerTools, SelectionState } from './tools';
import { registerPushNotifications } from './push';

/** Editor-title buttons accepting/rejecting the active CLI diff. */
export const ACCEPT_DIFF_COMMAND = 'copilotClient.cli.acceptDiff';
export const REJECT_DIFF_COMMAND = 'copilotClient.cli.rejectDiff';

/**
 * Wires up the whole CLI MCP integration: starts the in-process HTTP server,
 * registers the six tools + push notifications, writes the `~/.copilot/ide/*.lock`
 * discover file, and registers the Accept/Reject editor commands.
 *
 * Disposed with the extension: the server socket closes and the lock file is
 * removed so the CLI stops advertising VSCodium as an available IDE.
 */
export class CopilotCliMcpContrib implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly diffState = new DiffStateManager();
	private readonly httpServer = new InProcHttpServer();
	private readonly selectionState = new SelectionState();
	private readonly contentProvider = new ReadonlyContentProvider();
	private readonly sessionNames = new Map<string, string>();
	private lockFile: Awaited<ReturnType<typeof createLockFile>> | undefined;

	constructor() {
		this.disposables.push(
			vscode.commands.registerCommand(ACCEPT_DIFF_COMMAND, () => {
				this.respondToDiff('SAVED', 'accepted_via_button');
			}),
			vscode.commands.registerCommand(REJECT_DIFF_COMMAND, () => {
				this.respondToDiff('REJECTED', 'rejected_via_button');
			}),
		);

		for (const d of this.diffState.setupContextTracking()) {
			this.disposables.push(d);
		}
		this.disposables.push(this.contentProvider.register());
		this.disposables.push(
			this.httpServer.onDidClientDisconnect((sessionId) => {
				this.diffState.closeAllForSession(sessionId);
			}),
		);

		// Clear locks left behind by a crashed IDE, lest stale entries pile up.
		void cleanupStaleLockFiles().then(
			(count) => {
				if (count > 0) {
					log(`cleaned up ${count} stale lock file(s)`);
				}
			},
			(err) => log(`failed to clean up stale lock files: ${String(err)}`),
		);

		void this.startMcpServer();
	}

	dispose(): void {
		log('disposing Copilot CLI MCP contrib...');
		this.disposables.forEach((d) => d.dispose());
		this.disposables.length = 0;
		void this.lockFile?.remove().catch(() => undefined);
		this.lockFile = undefined;
		this.httpServer.dispose();
	}

	private respondToDiff(status: 'SAVED' | 'REJECTED', trigger: string): void {
		const diff = this.diffState.getForCurrentTab();
		if (!diff) {
			log(`[DIFF] no active diff for ${trigger}`);
			return;
		}
		log(`[DIFF] button → ${status} (${trigger}): ${diff.tabName}`);
		diff.cleanup();
		diff.resolve({ status, trigger });
	}

	private async startMcpServer(): Promise<void> {
		try {
			const serverInfo = await this.httpServer.start({
				id: 'vscodium-copilot-client', // MCP server id advertised to the CLI.
				serverLabel: 'Copilot CLI for VSCodium',
				serverVersion: '0.1.0',
				registerTools: (server, sessionId) => {
					log(`registering tools for session ${sessionId} (scheme ${READONLY_SCHEME} supported)`);
					registerTools(server, this.diffState, this.selectionState, this.contentProvider, this.sessionNames, sessionId);
				},
				registerPushNotifications: () => {
					this._registerPushNotifications();
				},
			});

			this.lockFile = await createLockFile(serverInfo.serverUri, serverInfo.headers);
			log(`MCP server started. Lock file: ${this.lockFile.path}`);
			log(`Server URI: ${serverInfo.serverUri.toString()}`);

			// Keep the lock's workspace list / trust state fresh.
			this.disposables.push(
				vscode.workspace.onDidChangeWorkspaceFolders(() => {
					void this.lockFile?.update();
					log('workspace folders changed, lock file updated');
				}),
				vscode.workspace.onDidGrantWorkspaceTrust(() => {
					void this.lockFile?.update();
					log('workspace trust changed, lock file updated');
				}),
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log(`failed to start MCP server: ${msg}`);
			void vscode.window.showWarningMessage(
				vscode.l10n.t('VSCodium Copilot Client: Copilot CLI MCP server failed to start: {0}', msg),
			);
		}
	}

	private _registerPushNotifications(): void {
		for (const d of registerPushNotifications(this.httpServer, this.selectionState)) {
			this.disposables.push(d);
		}
	}
}