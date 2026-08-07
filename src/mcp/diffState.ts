import * as vscode from 'vscode';
import { log } from '../log';

/** Context key gating the Accept/Reject buttons in the editor title bar. */
export const HAS_ACTIVE_DIFF_CONTEXT = 'copilotClient.cli.hasActiveDiff';

export interface ActiveDiff {
	diffId: string;
	sessionId?: string;
	tabName: string;
	originalUri: vscode.Uri;
	modifiedUri: vscode.Uri;
	newContents: string;
	cleanup: () => void;
	resolve: (result: { status: 'SAVED' | 'REJECTED'; trigger: string }) => void;
}

function isDiffTab(tab: vscode.Tab): tab is vscode.Tab & { input: vscode.TabInputTextDiff } {
	return tab.input instanceof vscode.TabInputTextDiff;
}

/**
 * Tracks the diffs opened via `open_diff`. The Accept/Reject commands look up
 * the diff for the active tab here, and disconnects close every diff belonging
 * to the vanished session.
 */
export class DiffStateManager {
	private readonly activeDiffs = new Map<string, ActiveDiff>();

	register(diff: ActiveDiff): void {
		log(`[DIFF] register: tab=${diff.tabName} diffId=${diff.diffId} (${this.activeDiffs.size} active)`);
		this.activeDiffs.set(diff.diffId, diff);
		this.updateContext();
	}

	unregister(diffId: string): void {
		this.activeDiffs.delete(diffId);
		this.updateContext();
	}

	getByTabName(tabName: string): ActiveDiff | undefined {
		for (const diff of this.activeDiffs.values()) {
			if (diff.tabName === tabName) {
				return diff;
			}
		}
		return undefined;
	}

	getByTab(tab: vscode.Tab): ActiveDiff | undefined {
		if (!isDiffTab(tab)) {
			return undefined;
		}
		const modifiedUri = tab.input.modified.toString();
		for (const diff of this.activeDiffs.values()) {
			if (diff.modifiedUri.toString() === modifiedUri) {
				return diff;
			}
		}
		return undefined;
	}

	getForCurrentTab(): ActiveDiff | undefined {
		const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
		return activeTab ? this.getByTab(activeTab) : undefined;
	}

	hasActiveDiffs(): boolean {
		return this.activeDiffs.size > 0;
	}

	/** Rejects (and cleans up) every diff belonging to a disconnected session. */
	closeAllForSession(sessionId: string): void {
		let closed = 0;
		for (const diff of this.activeDiffs.values()) {
			if (diff.sessionId === sessionId) {
				diff.resolve({ status: 'REJECTED', trigger: 'client_disconnected' });
				closed++;
			}
		}
		if (closed > 0) {
			log(`[DIFF] closed ${closed} diff(s) for disconnected session ${sessionId}`);
		}
	}

	/** Keeps the editor-title buttons visible only while a tracked diff is active. */
	setupContextTracking(): vscode.Disposable[] {
		return [
			vscode.window.tabGroups.onDidChangeTabGroups(() => this.updateContext()),
			vscode.window.tabGroups.onDidChangeTabs(() => this.updateContext()),
		];
	}

	private updateContext(): void {
		const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
		const isActiveDiff = activeTab ? this.getByTab(activeTab) !== undefined : false;
		void vscode.commands
			.executeCommand('setContext', HAS_ACTIVE_DIFF_CONTEXT, isActiveDiff)
			.then(undefined, (err) => log(`[DIFF] failed to update context: ${String(err)}`));
	}
}
