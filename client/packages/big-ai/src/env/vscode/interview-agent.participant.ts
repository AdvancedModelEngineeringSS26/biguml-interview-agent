/*********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 *********************************************************************************/

import type { OnActivate, OnDispose } from '@borkdominik-biguml/big-vscode/vscode';
import { injectable } from 'inversify';
import * as vscode from 'vscode';
import { AI_PARTICIPANT_ID, UML_TOOL_NAMES } from '../common/index.js';

@injectable()
export class InterviewAgentParticipant implements OnActivate, OnDispose {
    protected participant?: vscode.ChatParticipant;

    onActivate(): void {
        if (!vscode.chat?.createChatParticipant) {
            return;
        }

        this.participant = vscode.chat.createChatParticipant(AI_PARTICIPANT_ID, this.handleRequest.bind(this));
    }

    protected async handleRequest(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
        if (!model) {
            stream.markdown('No compatible chat model is available.');
            return {
                metadata: {
                    command: request.command ?? 'default',
                    toolUsed: false
                }
            };
        }

        const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(this.buildPrompt(request, context))];

        let toolUsed = false;

        for (let iteration = 0; iteration < 3 && !token.isCancellationRequested; iteration++) {
            const response = await model.sendRequest(
                messages,
                {
                    tools: vscode.lm.tools.filter(tool => tool.name === UML_TOOL_NAMES.dummy)
                },
                token
            );

            const toolCalls: vscode.LanguageModelToolCallPart[] = [];

            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    stream.markdown(part.value);
                    continue;
                }

                if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCalls.push(part);
                }
            }

            if (toolCalls.length === 0) {
                break;
            }

            toolUsed = true;
            messages.push(vscode.LanguageModelChatMessage.Assistant(toolCalls));

            for (const toolCall of toolCalls) {
                const toolResult = await vscode.lm.invokeTool(
                    toolCall.name,
                    {
                        input: toolCall.input as object,
                        toolInvocationToken: request.toolInvocationToken
                    },
                    token
                );
                messages.push(
                    vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(toolCall.callId, toolResult.content)
                    ])
                );
            }
        }

        return {
            metadata: {
                command: request.command ?? 'default',
                toolUsed
            }
        };
    }

    protected buildPrompt(request: vscode.ChatRequest, context: vscode.ChatContext): string {
        const intro =
            'You are the bigUML interview agent. When useful, call the registered dummy tool once to validate the VS Code LM tool integration. After the tool call, briefly explain the result to the user.';
        const referenceInfo = request.references.length > 0 ? `Attached references: ${request.references.length}.` : 'No attached references.';
        const historyInfo = context.history.length > 0 ? `Conversation turns so far: ${context.history.length}.` : 'This is the first turn.';

        return `${intro}\n${referenceInfo}\n${historyInfo}\nUser request: ${request.prompt}`;
    }

    dispose(): void {
        this.participant?.dispose();
        this.participant = undefined;
    }
}
