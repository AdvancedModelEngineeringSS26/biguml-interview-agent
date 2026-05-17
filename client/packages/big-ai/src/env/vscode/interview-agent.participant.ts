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
import { AI_PARTICIPANT_ID, UML_TOOL_NAMES, COMMAND_PATTERNS, SYSTEM_PROMPT } from '../common/index.js';
import type { ParsedCommand } from '../common/tool-types.js';


@injectable()
export class InterviewAgentParticipant implements OnActivate, OnDispose {
    protected participant?: vscode.ChatParticipant;
    protected outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('big-ai');
    }

    onActivate(): void {
        if (!vscode.chat?.createChatParticipant) {
            return;
        }

        this.participant = vscode.chat.createChatParticipant(AI_PARTICIPANT_ID, this.handleRequest.bind(this));
        
        this.participant.followupProvider = {
            provideFollowups: this.provideFollowups.bind(this)
        };

        this.outputChannel.appendLine('[big-ai] Interview Agent participant registered with follow-up provider');
    }


    protected buildHistoryMessages(context: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
        const messages: vscode.LanguageModelChatMessage[] = [];
        const MAX_HISTORY_TURNS = 10; 
        const recentHistory = context.history.slice(-MAX_HISTORY_TURNS); 

        for (const turn of recentHistory) { 
            if (turn instanceof vscode.ChatRequestTurn) {
                messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
            } else if (turn instanceof vscode.ChatResponseTurn) {
                const responseText = turn.response
                    .filter((part): part is vscode.ChatResponseMarkdownPart =>
                        part instanceof vscode.ChatResponseMarkdownPart
                    )
                    .map(part => part.value.value)
                    .join('\n');

                if (responseText.trim()) {
                    messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
                }
            }
        }
        return messages;
    }

    protected buildUserMessage(request: vscode.ChatRequest, command: ParsedCommand): string {
        if (command.argument.trim()) {
            return command.argument.trim();
        }
        const defaults: Record<string, string> = {
            interview: 'Please analyze the current UML diagram.',
            modify: 'Please suggest improvements to the current design.',
            explain: 'Please explain the current UML structure.',
            default: request.prompt
        };
        return defaults[command.type] ?? request.prompt;
    }

    protected async buildReferenceMessages(
        request: vscode.ChatRequest
    ): Promise<vscode.LanguageModelChatMessage[]> {
        const MAX_REFERENCE_CHARS = 30_000;
        const messages: vscode.LanguageModelChatMessage[] = [];

        for (const ref of request.references) {
            const label = ref.id;
            try {
                const resolved = await this.resolveReferenceContent(ref);
                if (resolved === undefined) {
                    this.outputChannel.appendLine(`[big-ai] Reference ${label}: unsupported value type, skipped`);
                    continue;
                }

                const { content, source } = resolved;
                const truncated = content.length > MAX_REFERENCE_CHARS;
                const payload = truncated
                    ? `${content.slice(0, MAX_REFERENCE_CHARS)}\n…[truncated, original length: ${content.length} chars]`
                    : content;

                this.outputChannel.appendLine(
                    `[big-ai] Reference ${label} resolved from ${source} (${content.length} chars${truncated ? ', truncated' : ''})`
                );

                messages.push(
                    vscode.LanguageModelChatMessage.User(
                        `[Attached reference: ${label}${source ? ` (${source})` : ''}]\n${payload}`
                    )
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.outputChannel.appendLine(`[big-ai] Reference ${label} failed to resolve: ${message}`);
                messages.push(
                    vscode.LanguageModelChatMessage.User(
                        `[Attached reference: ${label}]\n(Failed to read content: ${message})`
                    )
                );
            }
        }

        return messages;
    }

    protected getActiveUmlUri(): vscode.Uri | undefined {
        const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
        if (!activeTab) {
            return undefined;
        }

        const input = activeTab.input;
        let uri: vscode.Uri | undefined;
        if (input instanceof vscode.TabInputText) {
            uri = input.uri;
        } else if (input instanceof vscode.TabInputCustom) {
            uri = input.uri;
        } else if (input instanceof vscode.TabInputNotebook) {
            uri = input.uri;
        }

        if (!uri || !uri.path.toLowerCase().endsWith('.uml')) {
            return undefined;
        }
        return uri;
    }

    protected async buildAutoAttachMessages(
        request: vscode.ChatRequest
    ): Promise<vscode.LanguageModelChatMessage[]> {
        const MAX_CONTENT_CHARS = 30_000;
        const activeUri = this.getActiveUmlUri();
        if (!activeUri) {
            return [];
        }

        const alreadyAttached = request.references.some(ref => {
            const v = ref.value;
            if (v instanceof vscode.Uri) {
                return v.toString() === activeUri.toString();
            }
            if (v instanceof vscode.Location) {
                return v.uri.toString() === activeUri.toString();
            }
            return false;
        });
        if (alreadyAttached) {
            this.outputChannel.appendLine(
                `[big-ai] Active UML file ${activeUri.fsPath} already explicitly referenced, skipping auto-attach`
            );
            return [];
        }

        try {
            const bytes = await vscode.workspace.fs.readFile(activeUri);
            const content = new TextDecoder().decode(bytes);
            const truncated = content.length > MAX_CONTENT_CHARS;
            const payload = truncated
                ? `${content.slice(0, MAX_CONTENT_CHARS)}\n…[truncated, original length: ${content.length} chars]`
                : content;

            this.outputChannel.appendLine(
                `[big-ai] Auto-attached active UML file ${activeUri.fsPath} (${content.length} chars${truncated ? ', truncated' : ''})`
            );

            return [
                vscode.LanguageModelChatMessage.User(
                    `[Auto-attached active UML diagram: ${activeUri.fsPath}]\n${payload}`
                )
            ];
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`[big-ai] Failed to auto-attach active UML file: ${message}`);
            return [];
        }
    }

    protected async resolveReferenceContent(
        ref: vscode.ChatPromptReference
    ): Promise<{ content: string; source: string } | undefined> {
        const { value } = ref;

        if (value instanceof vscode.Uri) {
            const bytes = await vscode.workspace.fs.readFile(value);
            return { content: new TextDecoder().decode(bytes), source: value.fsPath };
        }

        if (value instanceof vscode.Location) {
            const document = await vscode.workspace.openTextDocument(value.uri);
            return {
                content: document.getText(value.range),
                source: `${value.uri.fsPath}:${value.range.start.line + 1}-${value.range.end.line + 1}`
            };
        }

        if (typeof value === 'string') {
            return { content: value, source: 'inline' };
        }

        return undefined;
    }


    protected async handleRequest(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        const parsedCommand = this.parseCommand(request.prompt);
        this.outputChannel.appendLine(`[big-ai] Request: ${request.prompt}`);
        this.outputChannel.appendLine(`[big-ai] Command type: ${parsedCommand.type}`);
        this.outputChannel.appendLine(`[big-ai] Conversation turn: ${context.history.length + 1}`);

        const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
        if (!model) {
            stream.markdown('**Error**: No compatible chat model (GPT-4o) is available. Please ensure Copilot Chat is installed and authenticated.');
            return {
                metadata: {
                    command: parsedCommand.type,
                    toolUsed: false,
                    error: 'MODEL_UNAVAILABLE'
                }
            };
        }

        const historyMessages = this.buildHistoryMessages(context);
        const referenceMessages = await this.buildReferenceMessages(request);
        const autoAttachMessages = await this.buildAutoAttachMessages(request);

        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(this.buildSystemMessage(request, parsedCommand)),
            ...historyMessages,
            ...referenceMessages,
            ...autoAttachMessages,
            vscode.LanguageModelChatMessage.User(this.buildUserMessage(request, parsedCommand))
        ];

        let toolUsed = false;
        let responseStreamed = false;

        try {
            for (let iteration = 0; iteration < 3 && !token.isCancellationRequested; iteration++) {
                this.outputChannel.appendLine(`[big-ai] LM request iteration ${iteration + 1}/3`);
                
                const response = await model.sendRequest(
                    messages,
                    {
                        tools: vscode.lm.tools.filter(tool => (Object.values(UML_TOOL_NAMES) as string[]).includes(tool.name))
                    },
                    token
                );

                const toolCalls: vscode.LanguageModelToolCallPart[] = [];

                for await (const part of response.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        stream.markdown(part.value);
                        responseStreamed = true;
                        continue;
                    }

                    if (part instanceof vscode.LanguageModelToolCallPart) {
                        toolCalls.push(part);
                    }
                }

                if (toolCalls.length === 0) {
                    this.outputChannel.appendLine(`[big-ai] No tool calls in iteration ${iteration + 1}, completing`);
                    break;
                }

                toolUsed = true;
                this.outputChannel.appendLine(`[big-ai] Tool calls collected: ${toolCalls.length}`);
                messages.push(vscode.LanguageModelChatMessage.Assistant(toolCalls));

                for (const toolCall of toolCalls) {
                    try {
                        const toolResult = await vscode.lm.invokeTool(
                            toolCall.name,
                            {
                                input: toolCall.input as object,
                                toolInvocationToken: request.toolInvocationToken
                            },
                            token
                        );
                        this.outputChannel.appendLine(`[big-ai] Tool invoked: ${toolCall.name}`);
                        messages.push(
                            vscode.LanguageModelChatMessage.User([
                                new vscode.LanguageModelToolResultPart(toolCall.callId, toolResult.content)
                            ])
                        );
                    } catch (toolError) {
                        this.outputChannel.appendLine(`[big-ai] Tool error: ${toolError instanceof Error ? toolError.message : String(toolError)}`);
                        throw toolError;
                    }
                }
            }
        } catch (error) {
            this.outputChannel.appendLine(`[big-ai] Request error: ${error instanceof Error ? error.message : String(error)}`);
            if (!responseStreamed) {
                stream.markdown(`**Error**: ${error instanceof Error ? error.message : 'Unknown error occurred'}`);
            }
        }

        this.outputChannel.appendLine(`[big-ai] Response complete (tool_used: ${toolUsed})`);

        return {
            metadata: {
                command: parsedCommand.type,
                toolUsed,
                responseStreamed,
                commandArgument: parsedCommand.argument || ''
            }
        };
    }

    protected parseCommand(prompt: string): ParsedCommand {
        const interviewMatch = prompt.match(COMMAND_PATTERNS.interview);
        if (interviewMatch) {
            return {
                type: 'interview',
                argument: interviewMatch[1] || ''
            };
        }

        const modifyMatch = prompt.match(COMMAND_PATTERNS.modify);
        if (modifyMatch) {
            return {
                type: 'modify',
                argument: modifyMatch[1] || ''
            };
        }

        const explainMatch = prompt.match(COMMAND_PATTERNS.explain);
        if (explainMatch) {
            return {
                type: 'explain',
                argument: explainMatch[1] || ''
            };
        }

        return {
            type: 'default',
            argument: prompt
        };
    }

    protected provideFollowups(
        result: vscode.ChatResult,
        _context: vscode.ChatContext,
        _token: vscode.CancellationToken
    ): vscode.ChatFollowup[] {
        const commandType = (result.metadata?.command ?? 'default') as string;
        
        const followupsByCommand: Record<string, vscode.ChatFollowup[]> = {
            interview: [
                {
                    prompt: '/interview What design patterns are applied?',
                    label: 'Ask about patterns'
                },
                {
                    prompt: '/interview How would this scale with more entities?',
                    label: 'Discuss scalability'
                },
                {
                    prompt: '/modify Refactor based on your findings',
                    label: 'Refactor now'
                }
            ],
            modify: [
                {
                    prompt: '/interview How does this improve the design?',
                    label: 'Explain improvements'
                },
                {
                    prompt: '/modify Apply another improvement',
                    label: 'More improvements'
                },
                {
                    prompt: '/explain Why is this a best practice?',
                    label: 'Learn the principle'
                }
            ],
            explain: [
                {
                    prompt: '/interview How is this applied here?',
                    label: 'See in context'
                },
                {
                    prompt: '/explain Show a related concept',
                    label: 'Learn more'
                },
                {
                    prompt: '/modify Apply this pattern',
                    label: 'Use this pattern'
                }
            ],
            default: [
                {
                    prompt: '/interview Let\'s analyze this design',
                    label: 'Deep dive'
                },
                {
                    prompt: '/modify How could we improve this?',
                    label: 'Get suggestions'
                },
                {
                    prompt: '/explain Clarify a concept',
                    label: 'Learn more'
                }
            ]
        };

        return followupsByCommand[commandType] || followupsByCommand['default'];
    }

    protected buildSystemMessage(request: vscode.ChatRequest, command: ParsedCommand): string {
        const commandContexts = {
            interview: `## Interview Mode Activation
                        You are in INTERVIEW mode. Your goals:
                        1. Ask probing questions that guide the user to deeper understanding
                        2. Help identify architectural issues through Socratic questioning
                        3. Explore edge cases and scalability concerns
                        4. Reference specific design patterns when applicable
                        5. Guide user toward best practices without direct prescription

                        Question examples:
                        - Coupling levels between components
                        - Scalability implications
                        - Adherence to SOLID principles
                        - Potential anti-patterns
                            - Alternative design approaches`,

            modify: `## Modification Mode Activation
                        You are in MODIFY mode. Your goals:
                        1. Identify specific issues or improvement opportunities
                        2. Propose concrete, implementable solutions
                        3. Provide before/after comparisons
                        4. Include code examples where relevant
                        5. Explain the benefits of each recommendation

                        Format for suggestions:
                        - Current Issue: [specific problem]
                        - Recommendation: [solution]
                        - Implementation: [how to apply]
                        - Benefits: [why this helps]`,

            explain: `## Explanation Mode Activation
                        You are in EXPLAIN mode. Your goals:
                        1. Provide clear, well-structured definitions
                        2. Use concrete examples from UML/OOP
                        3. Show relationships to related concepts
                        4. Provide practical applications
                        5. Make complex topics accessible

                        Format for explanations:
                        - Definition: [clear, concise]
                        - Key Characteristics: [important properties]
                        - Practical Examples: [real-world usage]
                        - Related Concepts: [connections]
                        - When to Use: [applicable scenarios]`,

            default: `## General Conversation Mode
                        Respond helpfully to UML-related questions while maintaining expert-level knowledge.
                        Proactively offer to dive deeper using /interview, /modify, or /explain modes.`
                                };

        const modeContext = commandContexts[command.type] || commandContexts['default'];

        const referenceInfo = this.describeReferences(request);
        const activeDiagramInfo = this.describeActiveDiagram(request);

        return `${SYSTEM_PROMPT}

---

${modeContext}

---

## Context Information
${referenceInfo}
${activeDiagramInfo}

## Reference Handling
When the user attaches references via chat variables such as \`#file:...\` or \`#selection\`, their content is appended to this conversation as messages labeled \`[Attached reference: <name>]\`. Treat that content as authoritative context for the user's current request, and quote element names or excerpts from it when relevant.

If a message labeled \`[Auto-attached active UML diagram: <path>]\` appears, the user has that diagram open in their editor. Use it as context when the user's question is about "this diagram", "the current model", or makes no other file reference. If the question is purely conceptual (e.g. "/explain what is a class diagram"), you may ignore the auto-attached content.`;
}

    protected describeActiveDiagram(request: vscode.ChatRequest): string {
        const activeUri = this.getActiveUmlUri();
        if (!activeUri) {
            return '- No active UML diagram detected in the editor.';
        }
        const alreadyAttached = request.references.some(ref => {
            const v = ref.value;
            if (v instanceof vscode.Uri) {
                return v.toString() === activeUri.toString();
            }
            if (v instanceof vscode.Location) {
                return v.uri.toString() === activeUri.toString();
            }
            return false;
        });
        return alreadyAttached
            ? `- Active UML diagram in editor: \`${activeUri.fsPath}\` (also explicitly referenced).`
            : `- Active UML diagram in editor: \`${activeUri.fsPath}\` (auto-attached below).`;
    }

    protected describeReferences(request: vscode.ChatRequest): string {
        if (request.references.length === 0) {
            return '- No attached references.';
        }

        const lines = request.references.map(ref => {
            const label = ref.id;
            const { value } = ref;
            if (value instanceof vscode.Uri) {
                return `- ${label} → file: \`${value.fsPath}\``;
            }
            if (value instanceof vscode.Location) {
                const r = value.range;
                return `- ${label} → selection: \`${value.uri.fsPath}\` lines ${r.start.line + 1}-${r.end.line + 1}`;
            }
            if (typeof value === 'string') {
                return `- ${label} → inline string (${value.length} chars)`;
            }
            return `- ${label} → unsupported reference type`;
        });

        return `Attached references (${request.references.length}):\n${lines.join('\n')}`;
    }


    dispose(): void {
        this.participant?.dispose();
        this.participant = undefined;
        this.outputChannel.appendLine('[big-ai] Interview Agent participant disposed');
    }
}
