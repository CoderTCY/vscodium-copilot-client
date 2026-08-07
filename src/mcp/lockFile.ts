import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../log';

/**
 * Lock file contents, mirroring the official Copilot extension
 * (extensions/copilot/.../copilotcli/vscode-node/lockFile.ts). The Copilot CLI
 * validates every field against a zod schema before accepting the lock, so the
 * shape must stay in sync with the official one.
 */
export interface LockFileInfo {
	socketPath: string;
	scheme: string;
	headers: Record<string, string>;
	pid: number;
	ideName: string;
	timestamp: number;
	workspaceFolders: string[];
	isTrusted: boolean;
}

/** `~/.copilot/ide` — honors `COPILOT_HOME` when set (mirrors the official CLI). */
export function getCopilotCliStateDir(): string {
	const home = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
	return path.join(home, 'ide');
}

export class LockFileHandle {
	private readonly lockFilePath: string;
	private readonly serverUri: vscode.Uri;
	private readonly headers: Record<string, string>;
	private readonly timestamp: number;

	constructor(lockFilePath: string, serverUri: vscode.Uri, headers: Record<string, string>, timestamp: number) {
		this.lockFilePath = lockFilePath;
		this.serverUri = serverUri;
		this.headers = headers;
		this.timestamp = timestamp;
	}

	get path(): string {
		return this.lockFilePath;
	}

	/**
	 * Rewrites the lock file with the current workspace folders / trust state.
	 * Called when the workspace layout or trust changes.
	 */
	async update(): Promise<void> {
		try {
			const lockInfo = this.buildLockInfo();
			await fs.writeFile(this.lockFilePath, JSON.stringify(lockInfo, null, 2), { mode: 0o600 });
			log(`lock file updated: ${this.lockFilePath}`);
		} catch (error) {
			log(`failed to update lock file: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async remove(): Promise<void> {
		try {
			await fs.unlink(this.lockFilePath);
			log(`lock file removed: ${this.lockFilePath}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				log(`failed to remove lock file: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private buildLockInfo(): LockFileInfo {
		return {
			socketPath: this.serverUri.path,
			scheme: this.serverUri.scheme,
			headers: this.headers,
			pid: process.pid,
			ideName: vscode.env.appName,
			timestamp: this.timestamp,
			workspaceFolders: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
			isTrusted: vscode.workspace.isTrusted,
		};
	}
}

/** Creates the `<uuid>.lock` file under `~/.copilot/ide`. */
export async function createLockFile(
	serverUri: vscode.Uri,
	headers: Record<string, string>,
): Promise<LockFileHandle> {
	const copilotDir = getCopilotCliStateDir();
	await fs.mkdir(copilotDir, { recursive: true, mode: 0o700 });

	const lockFilePath = path.join(copilotDir, `${crypto.randomUUID()}.lock`);
	const handle = new LockFileHandle(lockFilePath, serverUri, headers, Date.now());
	await handle.update();
	log(`created lock file: ${lockFilePath}`);
	return handle;
}

/**
 * Checks if a process with the given PID is still running.
 * Signal 0 is a "null signal": it does not kill, it only checks existence
 * (and that we are allowed to signal it).
 */
export function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Removes stale lock files whose owning process is gone (e.g. a crashed IDE).
 * Returns the number of cleaned-up files. Safe to run at startup.
 */
export async function cleanupStaleLockFiles(): Promise<number> {
	let files: string[];
	try {
		files = await fs.readdir(getCopilotCliStateDir());
	} catch {
		return 0;
	}

	const results = await Promise.all(
		files
			.filter((file) => file.endsWith('.lock'))
			.map(async (file) => {
				const filePath = path.join(getCopilotCliStateDir(), file);
				try {
					const info = JSON.parse(await fs.readFile(filePath, 'utf-8')) as LockFileInfo;
					if (!isProcessRunning(info.pid)) {
						await fs.unlink(filePath);
						log(`removed stale lock file for PID ${info.pid}: ${filePath}`);
						return true;
					}
				} catch {
					// Skip files that cannot be read or parsed.
				}
				return false;
			}),
	);

	return results.filter(Boolean).length;
}
