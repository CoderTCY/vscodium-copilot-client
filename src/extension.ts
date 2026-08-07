import * as vscode from 'vscode';
import { CompletionsError, streamCompletions } from './completions';
import { getCompletionModelIds } from './models';
import { log, showLog } from './log';
import { postProcess } from './postprocess';
import { CompletionQuota, getCompletionQuota } from './quota';
import { getCopilotAccess, resetCopilotAccess } from './token';
import { truncatePrefix, truncateSuffix } from './truncate';
import { CopilotCliMcpContrib } from './mcp/contrib';

/**
 * How often the status-bar quota indicator refetches the remaining completions
 * usage (ms). The entitlements endpoint is cheap and cached server-side.
 */
const QUOTA_REFRESH_MS = 15 * 60_000;

/**
 * Fallback engine id used when the model list cannot be fetched.
 */
const FALLBACK_MODEL = 'gpt-41-copilot';

/**
 * Right-hand status bar item for the remaining completions quota. Doubles as
 * the extension's entry point: clicking it opens the action menu (sign-in,
 * refresh quota, check status).
 */
let quotaItem: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
	log('activated: VSCodium Copilot Client 0.2.2');
	log(`host: ${vscode.env.appName} ${vscode.version} (${vscode.env.uiKind})`);

	const provider = new CompletionProvider();

	quotaItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
	quotaItem.command = 'copilotClient.actions';
	context.subscriptions.push(quotaItem);

	loadToggleState(context.globalState);

	// Optional Copilot CLI MCP integration: lets the terminal `copilot` CLI
	// discover this editor and drive diff reviews through it. Failure here must
	// never break the FIM completions.
	if (vscode.workspace.getConfiguration('copilotClient').get<boolean>('cliMcp.enabled', true)) {
		try {
			context.subscriptions.push(new CopilotCliMcpContrib());
			log('Copilot CLI MCP integration enabled');
		} catch (err) {
			log(`Copilot CLI MCP init failed: ${(err as Error).message}`);
		}
	}

	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider('*', provider),
		vscode.commands.registerCommand('copilotClient.checkStatus', () => checkStatus()),
		vscode.commands.registerCommand('copilotClient.actions', () => void showActions()),
		vscode.commands.registerCommand('copilotClient.toggleEnabled', () => void toggleCompletionsEnabled()),
		vscode.commands.registerCommand('copilotClient.refreshQuota', () => void updateQuotaItem(quotaItem!, true)),
		vscode.commands.registerCommand('copilotClient.refreshToken', async () => {
			await resetCopilotAccess();
			log('token refreshed');
			void vscode.window.showInformationMessage('VSCodium Copilot Client: token refreshed.');
		}),
	);

	void updateQuotaItem(quotaItem);
	const quotaTimer = setInterval(() => void updateQuotaItem(quotaItem!), QUOTA_REFRESH_MS);
	context.subscriptions.push(new vscode.Disposable(() => clearInterval(quotaTimer)));
}

export function deactivate(): void {
	quotaItem = undefined;
	log('deactivated');
}

class CompletionProvider implements vscode.InlineCompletionItemProvider {
	private lastWarning = 0;

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[]> {
		const cfg = vscode.workspace.getConfiguration('copilotClient');

		if (!isEnabled()) {
			return [];
		}

		const prefix = document.getText(new vscode.Range(0, 0, position.line, position.character));
		const suffix = document.getText(
			new vscode.Range(position.line, position.character, document.lineCount - 1, Number.MAX_SAFE_INTEGER),
		);

		const prompt = truncatePrefix(prefix, cfg.get<number>('prefixTokens', 1800));
		const suf = truncateSuffix(suffix, cfg.get<number>('suffixTokens', 500));

		let access;
		try {
			access = await getCopilotAccess();
		} catch (err) {
			const message = `sign-in failed: ${(err as Error).message}`;
			log(message);
			this.warnOnce(`VSCodium Copilot Client ${message}`);
			return [];
		}

		const model = await this.resolveModel(access);

		if (token.isCancellationRequested) {
			return [];
		}

		log(
			`request: ${access.proxy}/v1/engines/${model}/completions` +
			` | language=${document.languageId} | prefix=${prompt.length}ch | suffix=${suf.length}ch`,
		);

		let text = '';
		try {
			for await (const chunk of streamCompletions({
				proxy: access.proxy,
				model,
				token: access.token,
				prompt,
				suffix: suf,
				languageId: document.languageId,
				maxTokens: cfg.get<number>('maxTokens', 2048),
				signal: toAbortSignal(token),
				extraHeaders: editorHeaders(),
			})) {
				if (token.isCancellationRequested) break;
				text += chunk;
				if (text.length > 2000) break; // Enough for a first suggestion.
			}
		} catch (err) {
			if (isAbortError(err)) {
				// The user kept typing / the widget closed, cancelling this request.
				// Not an error — the next keystroke triggers a fresh request.
				log('request cancelled');
				return [];
			}
			const message = `request failed: ${(err as Error).message}`;
			log(message);
			if (err instanceof CompletionsError && (err.status === 401 || err.status === 403)) {
				// Token expired mid-flight — drop the cache so the next request re-authenticates.
				await resetCopilotAccess().catch(() => undefined);
			}
			this.warnOnce(`VSCodium Copilot Client ${message}`);
			return [];
		}

		log(
			`ctx: trigger=${_context.triggerKind} | selected=${JSON.stringify(_context.selectedCompletionInfo?.text ?? null)}` +
			` | pos=${position.line}:${position.character}`,
		);

		const suggestion = postProcess(text, prefix);
		log(`suggestion: ${suggestion ? `${suggestion.length} chars` : 'none'}`);
		if (!suggestion) return [];

		// Replace from the start of the current line up to the cursor, mirroring
		// the official Copilot client (ghostText/copCompletion.ts): the insert
		// text re-attaches the already-typed line content, so the "text to
		// replace" is always a prefix of the insert text. The filter never drops
		// the item (the typed line was NOT a prefix of the bare suggestion), and
		// accepting keeps the typed text intact.
		const cursorLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
		const range = new vscode.Range(position.line, 0, position.line, position.character);
		const insert = cursorLine + suggestion;
		log(
			`return: line=${JSON.stringify(cursorLine.slice(0, 60))}` +
			` | ins=${JSON.stringify(insert.slice(0, 60))}` +
			` | range=${range.start.line}:${range.start.character}..${range.end.line}:${range.end.character}`,
		);
		return [new vscode.InlineCompletionItem(insert, range)];
	}

	private async resolveModel(access: Awaited<ReturnType<typeof getCopilotAccess>>): Promise<string> {
		const configured = vscode.workspace.getConfiguration('copilotClient').get<string>('model');
		if (configured) return configured;

		try {
			const models = await getCompletionModelIds(access);
			if (models.length > 0) return models[0];
		} catch {
			// Fall back to the default engine id.
		}
		return FALLBACK_MODEL;
	}

	private warnOnce(message: string): void {
		if (Date.now() - this.lastWarning < 30_000) return;
		this.lastWarning = Date.now();
		void vscode.window.showWarningMessage(message);
	}
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal | undefined {
	if (token.isCancellationRequested) {
		return AbortSignal.abort();
	}
	const controller = new AbortController();
	token.onCancellationRequested(() => controller.abort());
	return controller.signal;
}

/**
 * True when the error comes from aborting the request (user kept typing /
 * widget dismissed). Not a real failure.
 */
function isAbortError(err: unknown): boolean {
	return err instanceof Error && (err.name === 'AbortError' || err.message === 'This operation was aborted');
}

/** Editor/session identifiers the Copilot API expects (mirrors the official client). */
function editorHeaders(): Record<string, string> {
	return {
		'Editor-Version': `${vscode.env.appName} ${vscode.version}`,
		'Editor-Plugin-Version': 'vscodium-copilot-client 0.2.2',
		'Copilot-Language-Server-Version': '0.1.0',
		'VScode-SessionId': vscode.env.sessionId,
		'VScode-MachineId': vscode.env.machineId,
	};
}

/**
 * Fetches the remaining completions quota and renders it into the status-bar
 * item. The item stays visible and clickable even when there is no quota to
 * report (not signed in / failed request) so it can serve as the sign-in entry
 * point.
 */
async function updateQuotaItem(item: vscode.StatusBarItem, force = false): Promise<void> {
	try {
		if (!isEnabled()) {
			item.text = '$(copilot-unavailable)';
			item.tooltip = vscode.l10n.t('VSCodium Copilot Client: inline completions are off');
			item.show();
			return;
		}

		const quota = await getCompletionQuota(force);
		if (!quota) {
			// No GitHub session or the plan reports no quota — offer sign-in.
			item.text = `$(copilot) ${vscode.l10n.t('Sign in')}`;
			item.tooltip = vscode.l10n.t('VSCodium Copilot Client: click to sign in or manage the account');
			item.show();
			return;
		}
		// Mirror the Copilot status bar: the icon carries state (exhausted →
		// warning); the detailed usage lives in the popup dashboard.
		// Percentage remaining or used amount, per the percent/amount toggle.
		// The 0% (exhausted) state uses the warning codicon instead of the plain one.
		const display = displayMode();
		const pct = Math.round(quota.percentRemaining);
		const amount = quota.entitlement !== undefined && quota.remaining !== undefined
			? `${quota.remaining}/${quota.entitlement}`
			: undefined;
		const suffix = quota.unlimited
			? ''
			: display === 'amount' && amount
				? vscode.l10n.t('Remaining {0}', amount)
				: vscode.l10n.t('Remaining {0}%', pct);
		item.text = !suffix
			? '$(copilot)'
			: pct === 0
				? `$(copilot-warning) ${suffix}`
				: `$(copilot) ${suffix}`;
		item.tooltip = `${quotaTooltip(quota)}\n${vscode.l10n.t('Click to open actions')}`;
		item.show();
	} catch (err) {
		item.text = '$(copilot) ?';
		item.tooltip = vscode.l10n.t('VSCodium Copilot Client: quota fetch failed ({0}) — click to refresh', (err as Error).message);
		item.show();
		log(`quota fetch failed: ${(err as Error).message}`);
	}
}

/**
 * Action menu opened by clicking the status-bar item. Pure actions only — the
 * quota figure itself lives on the status bar, so nothing here waits on the
 * network and the pick opens instantly.
 */
async function showActions(): Promise<void> {
	const enabled = isEnabled();
	const display = displayMode();

	const pick = await vscode.window.showQuickPick(
		[
			{
				label: `$(sign-in) ${vscode.l10n.t('Sign in / Switch GitHub account')}`,
				detail: vscode.l10n.t('Re-authenticate GitHub for Copilot'),
				action: () => void signInAndRefresh(),
			},
			{
				label: enabled
					? `$(pass) ${vscode.l10n.t('Completions: on — click to turn off')}`
					: `$(circle-slash) ${vscode.l10n.t('Completions: off — click to turn on')}`,
				detail: vscode.l10n.t('Toggle inline completions'),
				action: () => void toggleCompletionsEnabled(),
			},
			{
				label: display === 'percent'
					? `$(symbol-numeric) ${vscode.l10n.t('Status bar: percent — click for amount')}`
					: `$(symbol-numeric) ${vscode.l10n.t('Status bar: amount — click for percent')}`,
				detail: vscode.l10n.t('Switch what the status bar shows'),
				action: () => void toggleStatusBarDisplay(),
			},
			{
				label: `$(refresh) ${vscode.l10n.t('Refresh remaining quota')}`,
				detail: vscode.l10n.t('Re-fetch usage from GitHub'),
				action: () => void updateQuotaItem(quotaItem!, true),
			},
			{
				label: `$(info) ${vscode.l10n.t('Check API status')}`,
				detail: vscode.l10n.t('Verify auth, proxy, models and quota'),
				action: () => void checkStatus(),
			},
		],
		{ placeHolder: vscode.l10n.t('VSCodium Copilot Client') },
	);
	pick?.action?.();
}

/**
 * 10-cell usage bar (filled = used share of the quota).
 */
function progressBar(usedPercent: number): string {
	const filled = Math.round(Math.min(100, Math.max(0, usedPercent)) / 10);
	return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

/**
 * Forces a fresh GitHub sign-in, then refreshes the quota indicator.
 */
async function signInAndRefresh(): Promise<void> {
	try {
		await getCopilotAccess(true);
		log('signed in');
		await updateQuotaItem(quotaItem!, true);
		void vscode.window.showInformationMessage(vscode.l10n.t('VSCodium Copilot Client: signed in.'));
	} catch (err) {
		const message = (err as Error).message;
		log(`sign-in failed: ${message}`);
		void vscode.window.showErrorMessage(vscode.l10n.t('VSCodium Copilot Client: sign-in failed: {0}', message));
	}
}

/**
 * Runtime state for the two status-bar toggles (completions on/off and the
 * percent/amount display). Kept in the extension's `globalState` (Memento)
 * rather than in `copilotClient.*` workspace settings: some VSCodium builds reject
 * config writes for loosely-registered keys with "is not registered" and drop
 * the update. A memento write has no such registry dependency, so toggling
 * always works and always persists.
 */
const toggleState = {
	storage: undefined as vscode.Memento | undefined,
	enabled: true,
	display: 'percent' as 'percent' | 'amount',
};

function loadToggleState(memento: vscode.Memento): void {
	toggleState.storage = memento;
	const cfg = vscode.workspace.getConfiguration('copilotClient');
	// Seed once from settings (if the user set them by hand); afterwards the
	// memento values are authoritative.
	toggleState.enabled = memento.get<boolean | undefined>('enabled', undefined) ?? cfg.get<boolean>('enabled', true);
	toggleState.display =
		memento.get<'percent' | 'amount' | undefined>('statusBarDisplay', undefined) ??
		cfg.get<'percent' | 'amount'>('statusBarDisplay', 'percent');
}

function isEnabled(): boolean {
	return toggleState.enabled;
}

function displayMode(): 'percent' | 'amount' {
	return toggleState.display;
}

/** Persists a toggle to globalState; returns false (and flashes the reason) on failure. */
async function persistToggleState(key: 'enabled' | 'statusBarDisplay', value: boolean | string): Promise<boolean> {
	try {
		// `storage` is always set — loadToggleState runs during activation.
		await toggleState.storage!.update(key, value);
		return true;
	} catch (err) {
		const message = (err as Error).message;
		log(`toggle state update failed (${key}): ${message}`);
		void vscode.window.showErrorMessage(vscode.l10n.t('VSCodium Copilot Client: could not update toggle: {0}', message));
		return false;
	}
}

/**
 * Flips the inline-completions on/off switch and refreshes the status-bar indicator.
 */
async function toggleCompletionsEnabled(): Promise<void> {
	const next = !toggleState.enabled;
	if (!(await persistToggleState('enabled', next))) return;
	toggleState.enabled = next;
	log(`completions ${next ? 'enabled' : 'disabled'}`);
	await updateQuotaItem(quotaItem!, true);
}

/**
 * Flips what the status bar shows (`percent` vs. remaining/total `amount`).
 */
async function toggleStatusBarDisplay(): Promise<void> {
	const next = toggleState.display === 'percent' ? 'amount' : 'percent';
	if (!(await persistToggleState('statusBarDisplay', next))) return;
	toggleState.display = next;
	log(`status bar display: ${next}`);
	await updateQuotaItem(quotaItem!, true);
}

function quotaTooltip(quota: CompletionQuota): string {
	const lines = [
		quota.unlimited
			? vscode.l10n.t('Copilot completions: unlimited')
			: vscode.l10n.t('Remaining {0}%', Math.round(quota.percentRemaining)),
	];

	if (!quota.unlimited) {
		const usedPct = Math.min(100, Math.max(0, 100 - quota.percentRemaining));
		lines.push(progressBar(usedPct));
		const used = quota.used ?? (quota.entitlement !== undefined && quota.remaining !== undefined ? quota.entitlement - quota.remaining : undefined);
		if (used !== undefined) {
			lines.push(vscode.l10n.t('Used {0} of {1} completions', used, quota.entitlement ?? '?'));
		}
	}

	if (quota.resetDate) {
		const reset = new Date(quota.resetDate);
		if (!Number.isNaN(reset.getTime())) {
			lines.push(vscode.l10n.t('Resets: {0}', reset.toLocaleDateString()));
		}
	}

	if (quota.plan) {
		lines.push(vscode.l10n.t('Plan: {0}', quota.plan));
	}

	lines.push(vscode.l10n.t('Click to refresh'));
	return lines.join('\n');
}

async function checkStatus(): Promise<void> {
	showLog();
	try {
		const access = await getCopilotAccess();
		log(`token ok | proxy=${access.proxy}`);

		let models: string[] = [];
		try {
			models = await getCompletionModelIds(access);
			log(`models: ${models.length > 0 ? models.join(', ') : '(empty)'}`);
		} catch (err) {
			log(`model list failed: ${(err as Error).message}`);
		}

		let quotaLine = '';
		try {
			const quota = await getCompletionQuota(true);
			if (quota) {
				quotaLine = quota.unlimited
					? '\nCompletions: unlimited'
					: `\nCompletions: ${Math.round(quota.percentRemaining)}% remaining` +
						(quota.remaining !== undefined ? ` (${quota.remaining})` : '');
				log(`quota: ${quota.unlimited ? 'unlimited' : `${Math.round(quota.percentRemaining)}% remaining`}`);
			} else {
				log('quota: (none)');
			}
		} catch (err) {
			log(`quota fetch failed: ${(err as Error).message}`);
		}

		const modelLine = models.length > 0 ? models.slice(0, 3).join(', ') : `fallback: ${FALLBACK_MODEL}`;
		void vscode.window.showInformationMessage(
			vscode.l10n.t('VSCodium Copilot Client connected.\nProxy: {0}\nModels: {1}{2}', access.proxy, modelLine, quotaLine),
		);
	} catch (err) {
		const message = (err as Error).message;
		log(`check status failed: ${message}`);
		void vscode.window.showErrorMessage(vscode.l10n.t('VSCodium Copilot Client: {0}', message));
	}
}
