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
import type { InterviewPhase, InterviewState, ParsedCommand, ProposeDiagramInput } from '../common/tool-types.js';
import { formatProposalSummary } from './proposal-summary.js';

const MAX_HISTORY_TURNS = 10;
const INTERVIEW_TOOL_NAMES = [UML_TOOL_NAMES.readUmlFile, UML_TOOL_NAMES.proposeDiagram] as const;
const CONFIRMATION_TOOL_NAMES = [UML_TOOL_NAMES.readUmlFile, UML_TOOL_NAMES.proposeDiagram, UML_TOOL_NAMES.confirmGeneration] as const;

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
        const recentHistory = context.history.slice(-MAX_HISTORY_TURNS);

        for (const turn of recentHistory) {
            if (turn instanceof vscode.ChatRequestTurn) {
                messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
            } else if (turn instanceof vscode.ChatResponseTurn) {
                const responseText = turn.response
                    .filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
                    .map(part => part.value.value)
                    .join('\n');

                if (responseText.trim()) {
                    messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
                }
            }
        }
        return messages;
    }

    protected buildInterviewTranscript(context: vscode.ChatContext): string {
        const lines: string[] = [];
        const recentHistory = context.history.slice(-MAX_HISTORY_TURNS);

        for (const turn of recentHistory) {
            if (turn instanceof vscode.ChatRequestTurn) {
                lines.push(`User: ${turn.prompt}`);
                continue;
            }

            if (turn instanceof vscode.ChatResponseTurn) {
                const responseText = this.responseTurnText(turn);
                if (responseText.trim()) {
                    lines.push(`Assistant: ${responseText}`);
                }
            }
        }

        return lines.length > 0 ? lines.join('\n\n') : 'No prior chat history.';
    }

    protected responseTurnText(turn: vscode.ChatResponseTurn): string {
        return turn.response
            .filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
            .map(part => part.value.value)
            .join('\n');
    }

    protected buildUserMessage(request: vscode.ChatRequest, command: ParsedCommand): string {
        if (command.argument.trim()) {
            return command.argument.trim();
        }
        const defaults: Record<string, string> = {
            interview: 'Please start a requirements interview for a UML diagram.',
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
        const interviewState = this.deriveInterviewState(context, request.prompt, parsedCommand);
        const allowedToolNames = interviewState.awaitingConfirmation ? CONFIRMATION_TOOL_NAMES : INTERVIEW_TOOL_NAMES;

        this.outputChannel.appendLine(`[big-ai] Request: ${request.prompt}`);
        this.outputChannel.appendLine(`[big-ai] Command type: ${parsedCommand.type}`);
        this.outputChannel.appendLine(`[big-ai] Interview phase: ${interviewState.phase}`);
        this.outputChannel.appendLine(`[big-ai] Awaiting confirmation: ${interviewState.awaitingConfirmation}`);
        this.outputChannel.appendLine(`[big-ai] Conversation turn: ${context.history.length + 1}`);

        const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        if (!model) {
            stream.markdown(
                '**Error**: No compatible Copilot chat model is available. Please ensure GitHub Copilot Chat is installed and authenticated.'
            );
            return {
                metadata: {
                    command: parsedCommand.type,
                    toolUsed: false,
                    error: 'MODEL_UNAVAILABLE'
                }
            };
        }

        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(this.buildSystemMessage(request, context, parsedCommand, interviewState)),
            ...this.buildHistoryMessages(context),
            vscode.LanguageModelChatMessage.User(this.buildUserMessage(request, parsedCommand))
        ];

        let toolUsed = false;
        let responseStreamed = false;
        let presentedProposal: ProposeDiagramInput | undefined;
        let generated = false;

        try {
            const maxIterations = 5;
            for (let iteration = 0; iteration < maxIterations && !token.isCancellationRequested; iteration++) {
                this.outputChannel.appendLine(`[big-ai] LM request iteration ${iteration + 1}/${maxIterations}`);

                const response = await model.sendRequest(
                    messages,
                    {
                        tools: vscode.lm.tools.filter(tool => (allowedToolNames as readonly string[]).includes(tool.name))
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
                    // Plain interview turn: the model asked a question or answered. Text already streamed.
                    break;
                }

                // Arm: the model proposes a diagram. Render the summary deterministically and stop.
                const proposeCall = toolCalls.find(call => call.name === UML_TOOL_NAMES.proposeDiagram);
                if (proposeCall) {
                    toolUsed = true;
                    presentedProposal = proposeCall.input as ProposeDiagramInput;
                    this.outputChannel.appendLine('[big-ai] Proposal received; rendering summary and arming gate');
                    stream.markdown(formatProposalSummary(presentedProposal));
                    responseStreamed = true;
                    break;
                }

                // Fire: the model confirms. Generate from the stored proposal and stop.
                const confirmCall = toolCalls.find(call => call.name === UML_TOOL_NAMES.confirmGeneration);
                if (confirmCall) {
                    toolUsed = true;
                    const proposal = interviewState.pendingProposal;
                    if (!proposal) {
                        this.outputChannel.appendLine('[big-ai] Confirm called without a pending proposal');
                        stream.markdown('**Error**: No diagram proposal is pending. Please describe the diagram so I can propose it first.');
                        responseStreamed = true;
                        break;
                    }
                    this.outputChannel.appendLine('[big-ai] Generating from stored proposal');
                    const generationTool =
                        proposal.diagramType === 'DEPLOYMENT'
                            ? UML_TOOL_NAMES.generateDeploymentDiagram
                            : UML_TOOL_NAMES.generateClassDiagram;
                    const toolResult = await vscode.lm.invokeTool(
                        generationTool,
                        {
                            input: proposal as unknown as object,
                            toolInvocationToken: request.toolInvocationToken
                        },
                        token
                    );
                    const resultText = this.toolResultText(toolResult);
                    if (resultText.trim()) {
                        stream.markdown(resultText);
                        responseStreamed = true;
                    }
                    generated = true;
                    break;
                }

                // Otherwise (e.g. read-uml-file): invoke and feed results back so the model can continue.
                toolUsed = true;
                this.outputChannel.appendLine(`[big-ai] Tool calls collected: ${toolCalls.length}`);
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
                    this.outputChannel.appendLine(`[big-ai] Tool invoked: ${toolCall.name}`);
                    messages.push(
                        vscode.LanguageModelChatMessage.User([
                            new vscode.LanguageModelToolResultPart(toolCall.callId, toolResult.content)
                        ])
                    );
                }
            }
        } catch (error) {
            this.outputChannel.appendLine(`[big-ai] Request error: ${error instanceof Error ? error.message : String(error)}`);
            if (!responseStreamed) {
                stream.markdown(`**Error**: ${error instanceof Error ? error.message : 'Unknown error occurred'}`);
            }
        }

        this.outputChannel.appendLine(`[big-ai] Response complete (tool_used: ${toolUsed}, armed: ${presentedProposal !== undefined}, generated: ${generated})`);

        return {
            metadata: {
                command: parsedCommand.type,
                toolUsed,
                responseStreamed,
                commandArgument: parsedCommand.argument || '',
                interviewPhase: interviewState.phase,
                awaitingConfirmation: presentedProposal !== undefined,
                proposal: presentedProposal,
                generated
            }
        };
    }

    protected toolResultText(toolResult: vscode.LanguageModelToolResult): string {
        return toolResult.content
            .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
            .map(part => part.value)
            .join('\n');
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
        const awaitingConfirmation = result.metadata?.awaitingConfirmation === true;

        const followupsByCommand: Record<string, vscode.ChatFollowup[]> = {
            interview: awaitingConfirmation
                ? [
                      {
                          prompt: 'generate',
                          label: 'Generate'
                      },
                      {
                          prompt: '/interview Revise the summary',
                          label: 'Revise summary'
                      },
                      {
                          prompt: '/interview Add missing details',
                          label: 'Add details'
                      }
                  ]
                : [
                      {
                          prompt: '/interview Add the main entities',
                          label: 'Add entities'
                      },
                      {
                          prompt: '/interview Define relationships',
                          label: 'Define relationships'
                      },
                      {
                          prompt: '/interview Add attributes and operations',
                          label: 'Add details'
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
                    prompt: "/interview Let's analyze this design",
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

    protected deriveInterviewState(context: vscode.ChatContext, prompt: string, command: ParsedCommand): InterviewState {
        const pendingProposal = this.findPendingProposal(context);
        const awaitingConfirmation = pendingProposal !== undefined;
        const phase = this.deriveInterviewPhase(context, command, awaitingConfirmation);
        const diagramType = pendingProposal?.diagramType ?? this.deriveDiagramType(context, prompt, command);

        return {
            phase,
            diagramType,
            entities: [],
            relationships: [],
            details: [],
            awaitingConfirmation,
            pendingProposal
        };
    }

    protected findPendingProposal(context: vscode.ChatContext): ProposeDiagramInput | undefined {
        const recentHistory = context.history.slice(-MAX_HISTORY_TURNS);
        for (const turn of [...recentHistory].reverse()) {
            if (!(turn instanceof vscode.ChatResponseTurn)) {
                continue;
            }
            const metadata = turn.result?.metadata;
            if (!metadata) {
                continue;
            }
            // The most recent decision wins: a generation disarms; a proposal arms.
            if (metadata.generated === true) {
                return undefined;
            }
            if (metadata.proposal) {
                return metadata.proposal as ProposeDiagramInput;
            }
        }
        return undefined;
    }

    protected deriveDiagramType(
        context: vscode.ChatContext,
        prompt: string,
        command: ParsedCommand
    ): 'CLASS' | 'DEPLOYMENT' {
        if (this.isDeploymentIntent(prompt) || (command.type === 'interview' && this.isDeploymentIntent(command.argument))) {
            return 'DEPLOYMENT';
        }

        const history = [...context.history].reverse();
        for (const turn of history) {
            let text = '';
            if (turn instanceof vscode.ChatRequestTurn) {
                text = turn.prompt;
            } else if (turn instanceof vscode.ChatResponseTurn) {
                text = this.responseTurnText(turn);
            }

            if (this.isDeploymentIntent(text)) {
                return 'DEPLOYMENT';
            }
            if (/\bclass\b/i.test(text)) {
                return 'CLASS';
            }
        }

        return 'CLASS';
    }

    protected isDeploymentIntent(text: string): boolean {
        return /\b(deployment|device|execution\s*environment|communication\s*path)\b/i.test(text);
    }

    protected deriveInterviewPhase(
        context: vscode.ChatContext,
        command: ParsedCommand,
        awaitingConfirmation: boolean
    ): InterviewPhase {
        if (awaitingConfirmation) {
            return 'confirmation';
        }

        if (context.history.length === 0 || command.type === 'interview') {
            return 'scope';
        }

        return 'details';
    }

    protected buildInterviewStateInstruction(context: vscode.ChatContext, interviewState: InterviewState): string {
        const availableTools = interviewState.awaitingConfirmation
            ? 'readUmlFile, proposeDiagram, confirmGeneration'
            : 'readUmlFile, proposeDiagram';

        const stateRule = interviewState.awaitingConfirmation
            ? 'A complete proposal has already been shown to the user. If the user approves in any wording, call biguml-confirm-generation (no arguments). If the user requests any change, call biguml-propose-diagram again with the corrected specification. Otherwise answer their question or ask one clarifying question. Do not write the summary yourself.'
            : 'No proposal has been shown yet. Continue the interview by asking exactly one clear question, or call biguml-propose-diagram once scope, entities, relationships, details, and the target .uml file are all known. Do not call biguml-confirm-generation. You may offer concrete suggestions, but label them as suggestions the user can accept or change.';

        return `## Interview State
- Phase: ${interviewState.phase}
- Diagram type: ${interviewState.diagramType}
- Awaiting confirmation: ${interviewState.awaitingConfirmation}
- Tools available this turn: ${availableTools}

${stateRule}

## Chat History Transcript
Use this transcript as the source of truth for requirements. Do not invent missing requirements.
If the last user message is a .uml path, treat it as the target diagram file, not as attribute or operation details.
Only generate attributes or operations that the user explicitly named, explicitly accepted from the previous assistant suggestion, or explicitly requested no details.
Short acknowledgements such as yes, ok, sure, use those, that works, and sounds good confirm the concrete items suggested in the immediately previous assistant turn.

${this.buildInterviewTranscript(context)}`;
    }

    protected buildSystemMessage(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        command: ParsedCommand,
        interviewState: InterviewState
    ): string {
        const commandContexts = {
            interview: `## Interview Mode Activation
                        You are in INTERVIEW mode. Your goals:
                        1. Gather ${interviewState.diagramType.toLowerCase()} diagram requirements in this order: scope, entities, relationships, details, confirmation.
                        2. Ask exactly one clarifying question per assistant response when information is missing.
                        3. Avoid compound prompts such as multiple bullet questions, "for example" question lists, or several alternatives that all need answers.
                        4. When scope, entities, relationships, details, and the target .uml file are all known, call biguml-propose-diagram with the complete specification. Do not hand-write the summary; the tool renders it.
                        5. After a proposal is shown, call biguml-confirm-generation when the user approves in any wording, or call biguml-propose-diagram again if they request changes.
                        6. Generate only through these tools; never write raw UML, JSON, or a summary yourself.`,

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

        const referenceInfo =
            request.references.length > 0
                ? `Attached references: ${request.references.length} file(s) or context available for analysis.`
                : 'No attached references.';

        return `${SYSTEM_PROMPT}

---

${modeContext}

---

${this.buildInterviewStateInstruction(context, interviewState)}

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
