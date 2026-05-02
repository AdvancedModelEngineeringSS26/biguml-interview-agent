/*********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 *********************************************************************************/

declare module 'vscode' {
    export namespace chat {
        export function createChatParticipant(id: string, handler: ChatRequestHandler): ChatParticipant;
    }

    export interface ChatRequestHandler {
        (request: ChatRequest, context: ChatContext, stream: ChatResponseStream, token: CancellationToken): ProviderResult<ChatResult>;
    }

    export interface ChatParticipant extends Disposable {
        iconPath?: Uri | { light: Uri; dark: Uri } | ThemeIcon;
        followupProvider?: ChatFollowupProvider;
    }

    export interface ChatRequest {
        readonly prompt: string;
        readonly command?: string;
        readonly references: readonly ChatReference[];
    }

    export interface ChatReference {
        readonly value: unknown;
    }

    export interface ChatContext {
        readonly history: readonly unknown[];
    }

    export interface ChatResponseStream {
        markdown(value: string | MarkdownString): void;
        progress(value: string): void;
        button(command: Command): void;
    }

    export interface ChatResult {
        metadata?: Record<string, unknown>;
        errorDetails?: ChatErrorDetails;
    }

    export interface ChatErrorDetails {
        message: string;
        responseIsIncomplete?: boolean;
    }

    export interface ChatFollowup {
        prompt: string;
        label: string;
        command?: string;
    }

    export interface ChatFollowupProvider {
        provideFollowups(result: ChatResult, context: ChatContext, token: CancellationToken): ProviderResult<ChatFollowup[]>;
    }

    export namespace lm {
        export function registerTool<T>(name: string, tool: LanguageModelTool<T>): Disposable;
        export function invokeTool<T>(
            name: string,
            options: LanguageModelToolInvocationOptions<T>,
            token: CancellationToken
        ): Thenable<LanguageModelToolResult>;
        export function selectChatModels(selector?: LanguageModelChatSelector): Thenable<LanguageModelChat[]>;
        export const tools: readonly LanguageModelToolInformation[];
    }

    export interface LanguageModelChatSelector {
        vendor?: string;
        family?: string;
        version?: string;
        id?: string;
    }

    export interface LanguageModelToolInformation {
        readonly name: string;
    }

    export interface LanguageModelChat {
        sendRequest(
            messages: readonly LanguageModelChatMessage[],
            options: LanguageModelChatRequestOptions,
            token: CancellationToken
        ): Thenable<LanguageModelChatResponse>;
    }

    export interface LanguageModelChatRequestOptions {
        tools?: readonly LanguageModelToolInformation[];
    }

    export interface LanguageModelChatResponse {
        readonly stream: AsyncIterable<LanguageModelTextPart | LanguageModelToolCallPart>;
    }

    export class LanguageModelChatMessage {
        static User(content: string | MarkdownString): LanguageModelChatMessage;
        static Assistant(content: string | MarkdownString | readonly LanguageModelToolCallPart[]): LanguageModelChatMessage;
        static Tool(content: readonly LanguageModelTextPart[], callId: string): LanguageModelChatMessage;
    }

    export interface LanguageModelTool<T = unknown> {
        invoke(options: LanguageModelToolInvocationOptions<T>, token: CancellationToken): ProviderResult<LanguageModelToolResult>;
        prepareInvocation?(
            options: LanguageModelToolInvocationPrepareOptions<T>,
            token: CancellationToken
        ): ProviderResult<LanguageModelToolInvocationMessage | undefined>;
    }

    export interface LanguageModelToolInvocationOptions<T = unknown> {
        readonly input: T;
        readonly toolInvocationToken?: unknown;
    }

    export interface LanguageModelToolInvocationPrepareOptions<T = unknown> {
        readonly input: T;
        readonly toolInvocationToken?: unknown;
    }

    export interface LanguageModelToolInvocationMessage {
        readonly message: string | MarkdownString;
    }

    export class LanguageModelTextPart {
        constructor(value: string);
        readonly value: string;
    }

    export class LanguageModelToolCallPart {
        constructor(name: string, callId: string, input: unknown);
        readonly name: string;
        readonly callId: string;
        readonly input: unknown;
    }

    export class LanguageModelToolResult {
        constructor(content: readonly LanguageModelTextPart[]);
        readonly content: readonly LanguageModelTextPart[];
    }
}
