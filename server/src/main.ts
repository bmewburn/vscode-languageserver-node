/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import { LanguageServerError, MessageKind } from './languageServerError';
import {
		RequestType, IRequestHandler, NotificationType, INotificationHandler, ResponseError, ErrorCodes,
		MessageConnection, ServerMessageConnection, ILogger, createServerMessageConnection
	} from 'vscode-jsonrpc';
import {
		InitializeRequest, InitializeParams, InitializeResult, InitializeError, HostCapabilities, ServerCapabilities,
		ShutdownRequest, ShutdownParams,
		ExitNotification, ExitParams,
		LogMessageNotification, LogMessageParams, MessageType,
		ShowMessageNotification, ShowMessageParams,
		DidChangeConfigurationNotification, DidChangeConfigurationParams,
		DidOpenTextDocumentNotification, DidOpenTextDocumentParams, DidChangeTextDocumentNotification, DidChangeTextDocumentParams, DidCloseTextDocumentNotification, DidCloseTextDocumentParams,
		DidChangeFilesNotification, DidChangeFilesParams, FileEvent, FileChangeType,
		PublishDiagnosticsNotification, PublishDiagnosticsParams, Diagnostic, Severity, Position,
		TextDocumentIdentifier, TextDocumentPosition,
		HoverRequest, HoverResult
	} from './protocol';

import { Event, Emitter } from './utils/events';
import * as is from './utils/is';

// ------------- Reexport the API surface of the language worker API ----------------------
export {
		RequestType, IRequestHandler, NotificationType, INotificationHandler, ErrorCodes, ResponseError,
		InitializeResult, InitializeError,
		Diagnostic, Severity, Position,
		FileEvent, FileChangeType,
		TextDocumentIdentifier, TextDocumentPosition,
		HoverResult
}
export { LanguageServerError, MessageKind }
export { Event }


import * as fm from './files';
export namespace Files {
	export let uriToFilePath = fm.uriToFilePath;
	export let resolveModule = fm.resolveModule;
}

// ------------------------- text documents  --------------------------------------------------

export interface ITextDocument {
	uri: string;
	getText(): string;
}

class TextDocument implements ITextDocument {

	private _uri: string;
	private _content: string;

	public constructor(uri: string, content: string) {
		this._uri = uri;
		this._content = content;
	}

	public get uri(): string {
		return this._uri;
	}

	public getText(): string {
		return this._content;
	}

	public update(event: DidChangeTextDocumentParams): void {
		this._content = event.text;
	}
}

export interface TextDocumentHandler {
	incremental?: boolean;
	onDidOpenTextDocument(event: DidOpenTextDocumentParams): void;
	onDidChangeTextDocument(event: DidChangeTextDocumentParams): void;
	onDidCloseTextDocument(event: DidCloseTextDocumentParams): void;
}

export class TextDocumentChangeEvent {
	document: ITextDocument;
}

export class TextDocuments {

	private _documents : { [uri: string]: TextDocument };
	private _handler: TextDocumentHandler;

	public _onDidContentChange: Emitter<TextDocumentChangeEvent>;


	public constructor() {
		this._documents = Object.create(null);
		this._onDidContentChange = new Emitter<TextDocumentChangeEvent>();
		this._handler = {
			onDidOpenTextDocument: (event: DidOpenTextDocumentParams) => {
				let document = new TextDocument(event.uri, event.text);
				this._documents[event.uri] = document;
				this._onDidContentChange.fire({ document });
			},
			onDidChangeTextDocument: (event: DidChangeTextDocumentParams) => {
				let document = this._documents[event.uri];
				document.update(event);
				this._onDidContentChange.fire({ document });
			},
			onDidCloseTextDocument: (event: DidCloseTextDocumentParams) => {
				delete this._documents[event.uri];
			}
		}
	}

	public get onDidContentChange(): Event<TextDocumentChangeEvent> {
		return this._onDidContentChange.event;
	}

	public get(uri: string): ITextDocument {
		return this._documents[uri];
	}

	public all(): ITextDocument[] {
		return Object.keys(this._documents).map(key => this._documents[key]);
	}

	public keys(): string[] {
		return Object.keys(this._documents);
	}

	public observe(connection: IConnection): void {
		connection.onTextDocument(this._handler);
	}
}

// ------------------------- implementation of the language server protocol ---------------------------------------------

class ErrorMessageTracker {

	private messages: { [key: string]: number };
	constructor() {
		this.messages = Object.create(null);
	}
	public add(message: string): void {
		let count: number = this.messages[message];
		if (!count) {
			count = 0;
		}
		count++;
		this.messages[message] = count;
	}
	public publish(connection: { window: RemoteWindow }): void {
		Object.keys(this.messages).forEach(message => {
			connection.window.showErrorMessage(message);
		});
	}
}

export interface RemoteConsole {
	error(message: string);
	warn(message: string);
	info(message: string);
	log(message: string);
}

export interface RemoteWindow {
	showErrorMessage(message: string);
	showWarningMessage(message: string);
	showInformationMessage(message: string);
}

class Logger implements ILogger, RemoteConsole {
	private connection: MessageConnection;
	public constructor() {
	}
	public attach(connection: MessageConnection) {
		this.connection = connection;
	}
	public error(message: string): void {
		this.send(MessageType.Error, message);
	}
	public warn(message: string): void {
		this.send(MessageType.Warning, message);
	}
	public info(message: string): void {
		this.send(MessageType.Info, message);
	}
	public log(message: string): void {
		this.send(MessageType.Log, message);
	}
	private send(type: number, message: string) {
		if (this.connection) {
			this.connection.sendNotification(LogMessageNotification.type, { type, message });
		}
	}
}

class RemoteWindowImpl implements RemoteWindow {

	constructor(private connection: MessageConnection) {
	}

	public showErrorMessage(message: string) {
		this.connection.sendNotification(ShowMessageNotification.type, { type: MessageType.Error, message });
	}
	public showWarningMessage(message: string) {
		this.connection.sendNotification(ShowMessageNotification.type, { type: MessageType.Warning, message });
	}
	public showInformationMessage(message: string) {
		this.connection.sendNotification(ShowMessageNotification.type, { type: MessageType.Info, message });
	}
}

export interface IConnection {

	listen(): void;

	onRequest<P, R, E>(type: RequestType<P, R, E>, handler: IRequestHandler<P, R, E>): void;
	sendNotification<P>(type: NotificationType<P>, params?: P): void;
	onNotification<P>(type: NotificationType<P>, handler: INotificationHandler<P>): void;

	onInitialize(handler: IRequestHandler<InitializeParams, InitializeResult, InitializeError>): void;
	onShutdown(handler: IRequestHandler<ShutdownParams, void, void>): void;
	onExit(handler: INotificationHandler<ExitParams>): void;

	console: RemoteConsole;
	window: RemoteWindow;

	onDidChangeConfiguration(handler: INotificationHandler<DidChangeConfigurationParams>): void;
	onDidChangeFiles(handler: INotificationHandler<DidChangeFilesParams>): void;

	onTextDocument(handler: TextDocumentHandler): void;
	publishDiagnostics(args: PublishDiagnosticsParams): void;

	onHover(handler: IRequestHandler<TextDocumentPosition, HoverResult, void>): void;

	dispose(): void;
}

export function createConnection(inputStream: NodeJS.ReadableStream, outputStream: NodeJS.WritableStream): IConnection {
	let shutdownReceived: boolean;
	inputStream.on('end', () => {
		process.exit(shutdownReceived ? 0 : 1);
	});
	inputStream.on('close', () => {
		process.exit(shutdownReceived ? 0 : 1);
	});

	let logger = new Logger();
	let connection = createServerMessageConnection(inputStream, outputStream, logger);
	logger.attach(connection);
	let remoteWindow = new RemoteWindowImpl(connection);

	function asThenable<T>(value: T | Thenable<T>): Thenable<T> {
		if (is.thenable(value)) {
			return value;
		} else {
			return Promise.resolve<T>(<T>value);
		}
	}

	let shutdownHandler: IRequestHandler<ShutdownParams, void, void> = null;
	connection.onRequest(ShutdownRequest.type, (params) => {
		shutdownReceived = true;
		if (shutdownHandler) {
			return shutdownHandler(params);
		} else {
			return undefined;
		}
	});

	let incrementalSync: boolean = undefined;

	let initializeHandler: IRequestHandler<InitializeParams, InitializeResult, InitializeError> = null;
	connection.onRequest(InitializeRequest.type, (params) => {
		if (initializeHandler) {
			let result = initializeHandler(params);
			if (is.undefined(incrementalSync)) {
				return result;
			}
			return asThenable(result).then((value) => {
				if (value instanceof ResponseError) {
					return value;
				}
				let capabilities = (<InitializeResult>value).capabilities;
				if (capabilities) {
					capabilities.incrementalTextDocumentSync = incrementalSync;
				}
				return value;
			});
		} else {
			let result: InitializeResult = { capabilities: { incrementalTextDocumentSync: false } };
			return result;
		}
	});

	let result: IConnection = {
		listen: (): void => connection.listen(),
		onRequest: <P, R, E>(type: RequestType<P, R, E>, handler: IRequestHandler<P, R, E>): void => connection.onRequest(type, handler),
		sendNotification: <P>(type: NotificationType<P>, params?: P): void => connection.sendNotification(type, params),
		onNotification: <P>(type: NotificationType<P>, handler: INotificationHandler<P>): void => connection.onNotification(type, handler),

		onInitialize: (handler) => connection.onRequest(InitializeRequest.type, handler),
		onShutdown: (handler) => shutdownHandler = handler,
		onExit: (handler) => connection.onNotification(ExitNotification.type, handler),

		get console() { return logger; },
		get window() { return remoteWindow; },

		onDidChangeConfiguration: (handler) => connection.onNotification(DidChangeConfigurationNotification.type, handler),
		onDidChangeFiles: (handler) => connection.onNotification(DidChangeFilesNotification.type, handler),

		onTextDocument: (handler: TextDocumentHandler) => {
			if (handler.incremental === true || handler.incremental === false) {
				incrementalSync = handler.incremental;
			}
			connection.onNotification(DidOpenTextDocumentNotification.type, handler.onDidOpenTextDocument);
			connection.onNotification(DidChangeTextDocumentNotification.type, handler.onDidChangeTextDocument);
			connection.onNotification(DidCloseTextDocumentNotification.type, handler.onDidCloseTextDocument);
		},

		publishDiagnostics: (params) => connection.sendNotification(PublishDiagnosticsNotification.type, params),

		onHover: (handler) => connection.onRequest(HoverRequest.type, handler),

		dispose: () => connection.dispose()
	}

	return result;
}