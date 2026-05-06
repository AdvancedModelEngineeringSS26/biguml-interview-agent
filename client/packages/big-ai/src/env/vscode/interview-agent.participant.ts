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

        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(this.buildSystemMessage(request, parsedCommand)), 
            ...historyMessages,                                                                     
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
                        tools: vscode.lm.tools.filter(tool => tool.name === UML_TOOL_NAMES.dummy)
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
        
        const referenceInfo = request.references.length > 0 
            ? `Attached references: ${request.references.length} file(s) or context available for analysis.`
            : 'No attached references.';
        
        return `${SYSTEM_PROMPT}

---

${modeContext}

---

## Context Information
- ${referenceInfo}`;
}


    dispose(): void {
        this.participant?.dispose();
        this.participant = undefined;
        this.outputChannel.appendLine('[big-ai] Interview Agent participant disposed');
    }
}
