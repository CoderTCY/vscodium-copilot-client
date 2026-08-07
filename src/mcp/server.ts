import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Server as HttpServer } from 'http';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { log } from '../log';

interface McpProviderOptions {
	id: string;
	serverLabel: string;
	serverVersion: string;
	registerTools: (server: McpServer, sessionId: string) => Promise<void> | void;
	registerPushNotifications: () => void;
}

/**
 * In-process MCP-over-HTTP server listening on a named pipe (Windows) or a unix
 * socket. Mirrors the official `inProcHttpServer.ts`: `Nonce` auth, `/mcp`
 * endpoint, and one `StreamableHTTPServerTransport` per CLI session. The
 * Copilot CLI discovers us via the lock file written by `contrib.ts`.
 */
export class InProcHttpServer implements vscode.Disposable {
	private readonly transports: Record<string, StreamableHTTPServerTransport> = {};
	private readonly disposables: vscode.Disposable[] = [];
	private httpServer: HttpServer | undefined;
	private socketPath: string | undefined;

	private readonly connectEmitter = new vscode.EventEmitter<string>();
	/** Fired with the MCP session id when a client finishes `initialize`. */
	public readonly onDidClientConnect = this.connectEmitter.event;
	private readonly disconnectEmitter = new vscode.EventEmitter<string>();
	/** Fired with the MCP session id when a client session is closed. */
	public readonly onDidClientDisconnect = this.disconnectEmitter.event;

	broadcastNotification(method: string, params: Record<string, unknown>): void {
		const message = { jsonrpc: '2.0' as const, method, params };
		for (const sessionId of Object.keys(this.transports)) {
			void this.transports[sessionId].send(message).catch((e) => {
				log(`failed to send notification "${method}" to session ${sessionId}: ${String(e)}`);
			});
		}
	}

	sendNotification(sessionId: string, method: string, params: Record<string, unknown>): void {
		const transport = this.transports[sessionId];
		if (!transport) {
			log(`cannot send notification "${method}": session ${sessionId} not found`);
			return;
		}
		void transport.send({ jsonrpc: '2.0' as const, method, params }).catch((e) => {
			log(`failed to send notification "${method}" to session ${sessionId}: ${String(e)}`);
		});
	}

	getConnectedSessionIds(): readonly string[] {
		return Object.keys(this.transports);
	}

	/**
	 * Starts the HTTP server on a platform-appropriate socket and hands back the
	 * URI + auth headers to be written into the lock file.
	 */
	start(mcpOptions: McpProviderOptions): Promise<{ serverUri: vscode.Uri; headers: Record<string, string> }> {
		return new Promise((resolve, reject) => {
			void (async () => {
				try {
					const nonce = crypto.randomUUID();
					this.socketPath = await getRandomSocketPath();
					log(`MCP server socket: ${this.socketPath}`);

					const app = express();

					// open_diff carries full file contents, which can exceed the default ~100kb limit.
					app.use(express.json({ limit: '10mb' }));
					app.use((req, res, next) => this.authMiddleware(nonce, req, res, next));

					app.post('/mcp', (req, res) => void this.handlePost(mcpOptions, req, res));
					app.get('/mcp', (req, res) => void this.handleGetDelete(req, res));
					app.delete('/mcp', (req, res) => void this.handleGetDelete(req, res));

					const server = app.listen(this.socketPath, () => {
						this.httpServer = server;
						log(`MCP HTTP server listening on ${this.socketPath}`);

						mcpOptions.registerPushNotifications();

						resolve({
							serverUri: vscode.Uri.from({
								scheme: os.platform() === 'win32' ? 'pipe' : 'unix',
								path: this.socketPath as string,
								fragment: '/mcp',
							}),
							headers: { Authorization: `Nonce ${nonce}` },
						});
					});
					server.on('error', (err) => {
						log(`MCP server listen error: ${err.message}`);
						reject(err);
					});
				} catch (err) {
					void tryCleanupSocket(this.socketPath);
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			})();
		});
	}

	dispose(): void {
		log('shutting down MCP server...');
		for (const sessionId of Object.keys(this.transports)) {
			void this.transports[sessionId].close().catch(() => undefined);
			this.unregisterTransport(sessionId);
		}
		this.disposables.forEach((d) => d.dispose());
		this.disposables.length = 0;

		if (this.httpServer?.listening) {
			this.httpServer.close();
			this.httpServer.closeAllConnections();
		}
		void tryCleanupSocket(this.socketPath);
		this.httpServer = undefined;
		this.socketPath = undefined;
		this.connectEmitter.dispose();
		this.disconnectEmitter.dispose();
	}

	private registerTransport(sessionId: string, transport: StreamableHTTPServerTransport): void {
		this.transports[sessionId] = transport;
		this.connectEmitter.fire(sessionId);
		log(`Client connected: ${sessionId}`);
	}

	private unregisterTransport(sessionId: string): void {
		delete this.transports[sessionId];
		this.disconnectEmitter.fire(sessionId);
		log(`Client disconnected: ${sessionId}`);
	}

	private authMiddleware(nonce: string, req: Request, res: Response, next: NextFunction): void {
		if (req.headers.authorization !== `Nonce ${nonce}`) {
			log(`unauthorized request: ${req.method} ${req.path}`);
			res.status(401).send('Unauthorized');
			return;
		}
		next();
	}

	private async handlePost(mcpOptions: McpProviderOptions, req: Request, res: Response): Promise<void> {
		const rawSessionId = req.headers['mcp-session-id'] ?? req.headers['x-copilot-session-id'];
		if (Array.isArray(rawSessionId) || !rawSessionId || typeof rawSessionId !== 'string') {
			this.badRequest(res, -32000, 'Bad Request: Session ID must be a single, defined, string value');
			return;
		}
		const sessionId = rawSessionId;
		log(`POST /mcp, sessionId: ${sessionId}`);

		const existingTransport = this.transports[sessionId];
		if (existingTransport) {
			if (isInitializeRequest(req.body)) {
				this.badRequest(res, -32000, 'Conflict: A connection for this session already exists', 409);
				return;
			}
			await existingTransport.handleRequest(req, res, req.body);
			return;
		}

		if (!isInitializeRequest(req.body)) {
			this.badRequest(res, -32000, 'Bad Request: No valid session ID provided');
			return;
		}

		log('creating new MCP session...');
		const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => sessionId,
			onsessioninitialized: (mcpSessionId: string) => {
				this.registerTransport(mcpSessionId, transport);
			},
			onsessionclosed: (closedSessionId: string) => {
				this.unregisterTransport(closedSessionId);
			},
			enableDnsRebindingProtection: true,
			allowedHosts: ['localhost'],
		});

		const server = new McpServer({
			name: mcpOptions.id,
			version: mcpOptions.serverVersion,
		});

		try {
			await Promise.resolve(mcpOptions.registerTools(server, sessionId));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log(`failed to register MCP tools: ${msg}`);
			await transport.close().catch(() => undefined);
			this.badRequest(res, -32000, `Failed to register MCP tools: ${msg}`, 500);
			return;
		}

		await server.connect(transport);
		await transport.handleRequest(req, res, req.body);
	}

	private async handleGetDelete(req: Request, res: Response): Promise<void> {
		const sessionId = req.headers['mcp-session-id'];
		const transport = typeof sessionId === 'string' ? this.transports[sessionId] : undefined;
		if (!sessionId || !transport) {
			res.status(400).send('Invalid or missing session ID');
			return;
		}
		await transport.handleRequest(req, res);
	}

	private badRequest(res: Response, code: number, message: string, status = 400): void {
		res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
	}
}

async function getRandomSocketPath(): Promise<string> {
	if (os.platform() === 'win32') {
		return `\\\\.\\pipe\\mcp-${crypto.randomUUID()}.sock`;
	}
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-'));
	await fs.chmod(dir, 0o700);
	return path.join(dir, 'mcp.sock');
}

async function tryCleanupSocket(socketPath: string | undefined): Promise<void> {
	if (os.platform() === 'win32' || !socketPath) {
		return;
	}
	try {
		await fs.rm(path.dirname(socketPath), { recursive: true, force: true });
	} catch {
		// Best effort.
	}
}
