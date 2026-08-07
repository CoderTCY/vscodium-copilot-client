import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { log } from '../log';
import { DiffStateManager } from './diffState';
import { ReadonlyContentProvider, createReadonlyUri } from './readonlyContentProvider';

function makeTextResult(data: unknown): { content: [{ type: 'text'; text: string }] } {
	return {
		content: [
			{
				type: 'text',
				text: typeof data === 'string' ? data : (JSON.stringify(data, null, 2) ?? String(data)),
			},
		],
	};
}

function makeErrorResult(message: string): { content: [{ type: 'text'; text: string }]; isError: true } {
	return {
		content: [{ type: 'text', text: message }],
		isError: true,
	};
}

// ---- get_selection ----

export interface SelectionInfo {
	text: string;
	filePath: string;
	fileUrl: string;
	selection: {
		start: { line: number; character: number };
		end: { line: number; character: number };
		isEmpty: boolean;
	};
}

export function getSelectionInfo(editor: vscode.TextEditor): SelectionInfo {
	const selection = editor.selection;
	return {
		text: editor.document.getText(selection),
		filePath: editor.document.uri.fsPath,
		fileUrl: editor.document.uri.toString(),
		selection: {
			start: { line: selection.start.line, character: selection.start.character },
			end: { line: selection.end.line, character: selection.end.character },
			isEmpty: selection.isEmpty,
		},
	};
}

export class SelectionState {
	private latestSelection: SelectionInfo | null = null;

	update(selection: SelectionInfo | null): void {
		this.latestSelection = selection;
	}

	get latest(): SelectionInfo | null {
		return this.latestSelection;
	}
}

/**
 * Registers the six tools the Copilot CLI calls against the IDE. Schemas and
 * return shapes mirror the official `copilotcli/tools/*` implementation so the
 * CLI (1.0.78) accepts them unchanged.
 */
export function registerTools(
	server: McpServer,
	diffState: DiffStateManager,
	selectionState: SelectionState,
	contentProvider: ReadonlyContentProvider,
	sessionNames: Map<string, string>,
	sessionId: string,
): void {
	// ---- get_vscode_info ----
	server.registerTool(
		'get_vscode_info',
		{ description: 'Get information about the current VS Code instance' },
		async () => {
			log('tool: get_vscode_info');
			return makeTextResult({
				version: vscode.version,
				appName: vscode.env.appName,
				appRoot: vscode.env.appRoot,
				language: vscode.env.language,
				machineId: vscode.env.machineId,
				sessionId: vscode.env.sessionId,
				uriScheme: vscode.env.uriScheme,
				shell: vscode.env.shell,
			});
		},
	);

	// ---- get_selection ----
	server.registerTool(
		'get_selection',
		{
			description:
				'Get text selection. Returns current selection if an editor is active, otherwise returns the latest cached selection. The "current" field indicates if this is from the active editor (true) or cached (false).',
		},
		async () => {
			log('tool: get_selection');
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				return makeTextResult({ ...getSelectionInfo(editor), current: true });
			}
			if (selectionState.latest) {
				return makeTextResult({ ...selectionState.latest, current: false });
			}
			return makeTextResult(null);
		},
	);

	// ---- get_diagnostics ----
	server.registerTool(
		'get_diagnostics',
		{
			description: 'Gets language diagnostics (errors, warnings, hints) from VS Code',
			inputSchema: {
				uri: z.string().optional().describe('File URI to get diagnostics for. Optional. If not provided, returns diagnostics for all files.'),
			},
		},
		// @ts-ignore - TS2589: zod type instantiation too deep for registerTool() generics
		async (args: { uri?: string }) => {
			const { uri } = args;
			log(`tool: get_diagnostics${uri ? ` for: ${uri}` : ' (all files)'}`);
			let diagnostics: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
			if (uri) {
				const fileUri = vscode.Uri.parse(uri);
				diagnostics = [[fileUri, vscode.languages.getDiagnostics(fileUri)]];
			} else {
				diagnostics = vscode.languages.getDiagnostics();
			}

			const result = diagnostics
				.map(([fileUri, fileDiagnostics]) => ({
					uri: fileUri.toString(),
					filePath: fileUri.fsPath,
					diagnostics: fileDiagnostics.map((d) => ({
						message: d.message,
						severity: vscode.DiagnosticSeverity[d.severity].toLowerCase(),
						range: {
							start: { line: d.range.start.line, character: d.range.start.character },
							end: { line: d.range.end.line, character: d.range.end.character },
						},
						source: d.source,
						code: typeof d.code === 'object' ? d.code.value : d.code,
					})),
				}))
				.filter((item) => item.diagnostics.length > 0);

			return makeTextResult(result);
		},
	);

	// ---- open_diff ----
	server.registerTool(
		'open_diff',
		{
			description:
				'Opens a diff view comparing original file content with new content. Blocks until user accepts, rejects, or closes the diff.',
			inputSchema: {
				original_file_path: z.string().describe('Path to the original file'),
				new_file_contents: z.string().describe('The new file contents to compare against'),
				tab_name: z.string().describe('Name for the diff tab'),
			},
		},
		// @ts-ignore - TS2589: zod type instantiation too deep for registerTool() generics
		async (args: { original_file_path: string; new_file_contents: string; tab_name: string }) => {
			const { original_file_path, new_file_contents, tab_name } = args;
			log(`[DIFF] ===== OPEN_DIFF START ===== file=${original_file_path}, tab=${tab_name}`);
			try {
				// Read the original file for the readonly left side (new-file → empty).
				let originalContent: string;
				try {
					originalContent = await fs.readFile(original_file_path, 'utf-8');
				} catch (err) {
					const e = err as NodeJS.ErrnoException;
					if (e.code === 'ENOENT') {
						originalContent = '';
					} else {
						throw err;
					}
				}

				// Unique query suffix keeps each diff's two documents distinct.
				const uniqueSuffix = `${Date.now()}-${crypto.randomUUID()}`;
				const originalUri = createReadonlyUri(original_file_path, `original-${uniqueSuffix}`);
				const newUri = createReadonlyUri(original_file_path, `modified-${uniqueSuffix}`);

				contentProvider.setContent(originalUri, originalContent);
				contentProvider.setContent(newUri, new_file_contents);

				await vscode.commands.executeCommand('vscode.diff', originalUri, newUri, tab_name, {
					preview: false,
					preserveFocus: true,
				});

				// Wait for Accept / Reject / tab close.
				const result = await new Promise<{ status: 'SAVED' | 'REJECTED'; trigger: string }>((resolve) => {
					const disposables: vscode.Disposable[] = [];
					const diffId = newUri.toString();
					let cleanedUp = false;

					const cleanup = () => {
						if (cleanedUp) {
							return;
						}
						cleanedUp = true;
						disposables.forEach((d) => d.dispose());
						diffState.unregister(diffId);
						contentProvider.clearContent(originalUri);
						contentProvider.clearContent(newUri);
					};

					const closeDiffTab = async () => {
						for (const group of vscode.window.tabGroups.all) {
							for (const tab of group.tabs) {
								if (
									tab.input instanceof vscode.TabInputTextDiff &&
									tab.input.modified.toString() === newUri.toString()
								) {
									try {
										await vscode.window.tabGroups.close(tab);
									} catch (e) {
										log(`[DIFF] tab close error: ${e instanceof Error ? e.message : String(e)}`);
									}
									return;
								}
							}
						}
					};

					const wrappedResolve = (r: { status: 'SAVED' | 'REJECTED'; trigger: string }) => {
						cleanup();
						void closeDiffTab();
						resolve(r);
					};

					diffState.register({
						diffId,
						sessionId,
						tabName: tab_name,
						originalUri,
						modifiedUri: newUri,
						newContents: new_file_contents,
						cleanup,
						resolve: wrappedResolve,
					});

					disposables.push(
						vscode.window.tabGroups.onDidChangeTabs((event) => {
							for (const closedTab of event.closed) {
								const diff = diffState.getByTab(closedTab);
								if (diff && diff.diffId === diffId) {
									// User closed the tab manually — clean up but do NOT resolve;
									// the client handles its own timeout.
									log(`[DIFF] tab closed manually: ${tab_name}`);
									cleanup();
									return;
								}
							}
						}),
					);
				});

				log(`[DIFF] ===== OPEN_DIFF END ===== result=${result.status} (${result.trigger})`);
				return makeTextResult({
					success: true,
					result: result.status,
					trigger: result.trigger,
					tab_name,
					message:
						result.status === 'SAVED'
							? `User accepted changes for ${original_file_path}`
							: `User rejected changes for ${original_file_path}`,
				});
			} catch (err) {
				log(`[DIFF] ERROR: ${err instanceof Error ? err.message : String(err)}`);
				return makeErrorResult(`Failed to open diff: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	);

	// ---- close_diff ----
	server.registerTool(
		'close_diff',
		{
			description:
				'Closes a diff tab by its tab name. Use this when the client rejects an edit to close the corresponding diff view.',
			inputSchema: {
				tab_name: z.string().describe('The tab name of the diff to close (must match the tab_name used when opening the diff)'),
			},
		},
		// @ts-ignore - TS2589: zod type instantiation too deep for registerTool() generics
		async (args: { tab_name: string }) => {
			const { tab_name } = args;
			log(`tool: close_diff tab=${tab_name}`);
			const diff = diffState.getByTabName(tab_name);
			if (!diff) {
				return makeTextResult({
					success: true,
					already_closed: true,
					tab_name,
					message: `No active diff found with tab name "${tab_name}" (may already be closed)`,
				});
			}
			// The rejection flow cleans up and closes the tab.
			diff.resolve({ status: 'REJECTED', trigger: 'closed_via_tool' });
			return makeTextResult({
				success: true,
				already_closed: false,
				tab_name,
				message: `Diff "${tab_name}" closed successfully`,
			});
		},
	);

	// ---- update_session_name ----
	server.registerTool(
		'update_session_name',
		{
			description: 'Update the display name for the current CLI session',
			inputSchema: {
				name: z.string().describe('The new session name'),
			},
		},
		// @ts-ignore - TS2589: zod type instantiation too deep for registerTool() generics
		async (args: { name: string }) => {
			const { name } = args;
			log(`tool: update_session_name session=${sessionId} name=${name}`);
			sessionNames.set(sessionId, name);
			return makeTextResult({ success: true });
		},
	);
}