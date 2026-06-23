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
import type { GenerateClassDiagramInput, InterviewPhase, InterviewState, ParsedCommand } from '../common/tool-types.js';

const MAX_HISTORY_TURNS = 10;
const READ_ONLY_TOOL_NAMES = [UML_TOOL_NAMES.readUmlFile] as const;
const GENERATION_TOOL_NAMES = [
    UML_TOOL_NAMES.generateClassDiagram
] as const;

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
            .filter((part): part is vscode.ChatResponseMarkdownPart =>
                part instanceof vscode.ChatResponseMarkdownPart
            )
            .map(part => part.value.value)
            .join('\n');
    }

    protected buildUserMessage(request: vscode.ChatRequest, command: ParsedCommand): string {
        if (command.argument.trim()) {
            return command.argument.trim();
        }
        const defaults: Record<string, string> = {
            interview: 'Please start a requirements interview for a UML class diagram.',
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
        const allowedToolNames = interviewState.confirmed ? GENERATION_TOOL_NAMES : READ_ONLY_TOOL_NAMES;

        this.outputChannel.appendLine(`[big-ai] Request: ${request.prompt}`);
        this.outputChannel.appendLine(`[big-ai] Command type: ${parsedCommand.type}`);
        this.outputChannel.appendLine(`[big-ai] Interview phase: ${interviewState.phase}`);
        this.outputChannel.appendLine(`[big-ai] Generation confirmed: ${interviewState.confirmed}`);
        this.outputChannel.appendLine(`[big-ai] Conversation turn: ${context.history.length + 1}`);

        const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        if (!model) {
            stream.markdown('**Error**: No compatible Copilot chat model is available. Please ensure GitHub Copilot Chat is installed and authenticated.');
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
            vscode.LanguageModelChatMessage.User(this.buildSystemMessage(request, context, parsedCommand, interviewState)),
            ...historyMessages,
            vscode.LanguageModelChatMessage.User(this.buildUserMessage(request, parsedCommand))
        ];

        let toolUsed = false;
        let responseStreamed = false;
        const requireToolCalls = interviewState.confirmed;

        try {
            let generationRetryRequested = false;

            const maxGenerationIterations = 3;
            for (let iteration = 0; iteration < maxGenerationIterations && !token.isCancellationRequested; iteration++) {
                this.outputChannel.appendLine(`[big-ai] LM request iteration ${iteration + 1}/${maxGenerationIterations}`);
                
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
                        if (!requireToolCalls) {
                            stream.markdown(part.value);
                            responseStreamed = true;
                        }
                        continue;
                    }

                    if (part instanceof vscode.LanguageModelToolCallPart) {
                        toolCalls.push(part);
                    }
                }

                if (toolCalls.length === 0) {
                    this.outputChannel.appendLine(`[big-ai] No tool calls in iteration ${iteration + 1}, completing`);
                    if (requireToolCalls && !generationRetryRequested) {
                        generationRetryRequested = true;
                        this.outputChannel.appendLine('[big-ai] Confirmed generation produced no tool call; deriving aggregate input as JSON');
                        const generatedInput = await this.requestGenerationInput(model, messages, token);
                        const toolResult = await vscode.lm.invokeTool(
                            UML_TOOL_NAMES.generateClassDiagram,
                            {
                                input: generatedInput as unknown as object,
                                toolInvocationToken: request.toolInvocationToken
                            },
                            token
                        );
                        toolUsed = true;
                        const resultText = this.toolResultText(toolResult);
                        if (resultText.trim()) {
                            stream.markdown(resultText);
                            responseStreamed = true;
                        }
                        break;
                    }
                    if (requireToolCalls && !responseStreamed) {
                        this.outputChannel.appendLine('[big-ai] Generation turn produced text instead of tool calls; suppressing model text');
                        stream.markdown(
                            '**Error**: Generation was confirmed, but the diagram generator could not derive the generation input.'
                        );
                        responseStreamed = true;
                    }
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
                commandArgument: parsedCommand.argument || '',
                interviewPhase: interviewState.phase,
                awaitingConfirmation: interviewState.awaitingConfirmation,
                generationConfirmed: interviewState.confirmed
            }
        };
    }

    protected async requestGenerationInput(
        model: vscode.LanguageModelChat,
        messages: vscode.LanguageModelChatMessage[],
        token: vscode.CancellationToken
    ): Promise<GenerateClassDiagramInput> {
        const extractionMessages = [
            ...messages,
            vscode.LanguageModelChatMessage.User(`Return only the JSON input for biguml-generate-class-diagram. Do not call tools and do not include markdown.
The JSON shape is:
{
  "filePath": "workspace-relative-target.uml",
  "diagramType": "CLASS",
  "entities": [
    {
      "name": "ClassName",
      "elementType": "Class | AbstractClass | Interface | Enumeration | Package | DataType | PrimitiveType",
      "properties": [{ "name": "propertyName", "typeName": "TypeName", "visibility": "PUBLIC | PRIVATE | PROTECTED | PACKAGE", "multiplicity": "optional" }],
      "operations": [{ "name": "operationName", "visibility": "PUBLIC | PRIVATE | PROTECTED | PACKAGE" }]
    }
  ],
  "relationships": [
    {
      "relationType": "Association | Aggregation | Composition | Generalization | Dependency | InterfaceRealization | Realization | Abstraction | Usage",
      "sourceName": "SourceClass",
      "targetName": "TargetClass",
      "name": "optional relation label",
      "sourceMultiplicity": "optional",
      "targetMultiplicity": "optional"
    }
  ]
}
Use only confirmed information from the transcript. Include relationships after all entities. If operations have return types in the transcript, keep only the operation names because the current tool schema has no operation return type field.`)
        ];

        const response = await model.sendRequest(extractionMessages, {}, token);
        let text = '';
        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                text += part.value;
            }
        }

        const parsed = this.parseJsonObject(text);
        return parsed as GenerateClassDiagramInput;
    }

    protected parseJsonObject(text: string): unknown {
        const trimmed = text.trim();
        if (!trimmed) {
            throw new Error('The language model returned no generation input.');
        }

        const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const candidate = fencedMatch?.[1]?.trim() ?? trimmed;
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start < 0 || end < start) {
            throw new Error('The language model did not return JSON generation input.');
        }

        try {
            return JSON.parse(candidate.slice(start, end + 1));
        } catch (error) {
            throw new Error(`Invalid JSON generation input: ${error instanceof Error ? error.message : String(error)}`);
        }
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

    protected deriveInterviewState(context: vscode.ChatContext, prompt: string, command: ParsedCommand): InterviewState {
        const confirmed = this.isConfirmationTurn(context, prompt);
        const awaitingConfirmation = this.previousAssistantRequestedGeneration(context);
        const phase = this.deriveInterviewPhase(context, command, awaitingConfirmation, confirmed);

        return {
            phase,
            diagramType: 'CLASS',
            entities: [],
            relationships: [],
            details: [],
            awaitingConfirmation,
            confirmed
        };
    }

    protected deriveInterviewPhase(
        context: vscode.ChatContext,
        command: ParsedCommand,
        awaitingConfirmation: boolean,
        confirmed: boolean
    ): InterviewPhase {
        if (confirmed) {
            return 'generation';
        }

        if (awaitingConfirmation) {
            return 'confirmation';
        }

        if (context.history.length === 0 || command.type === 'interview') {
            return 'scope';
        }

        return 'details';
    }

    protected isConfirmationTurn(context: vscode.ChatContext, prompt: string): boolean {
        if (!this.previousAssistantRequestedGeneration(context)) {
            return false;
        }

        return /\b(generate|create|confirm|confirmed|yes|yep|looks good|go ahead|proceed)\b/i.test(prompt);
    }

    protected previousAssistantRequestedGeneration(context: vscode.ChatContext): boolean {
        for (const turn of [...context.history].reverse()) {
            if (!(turn instanceof vscode.ChatResponseTurn)) {
                continue;
            }

            const responseText = this.responseTurnText(turn).toLowerCase();
            return (
                responseText.includes('summary') &&
                responseText.includes('reply "generate"') &&
                /missing information:\s*(none|no missing information)/i.test(responseText)
            );
        }

        return false;
    }

    protected previousSummaryHasRelationships(context: vscode.ChatContext): boolean {
        return this.previousSummaryLineHasContent(context, 'Relationships');
    }

    protected previousSummaryHasEntities(context: vscode.ChatContext): boolean {
        return this.previousSummaryLineHasContent(context, 'Entities');
    }

    protected previousSummaryLineHasContent(context: vscode.ChatContext, label: string): boolean {
        for (const turn of [...context.history].reverse()) {
            if (!(turn instanceof vscode.ChatResponseTurn)) {
                continue;
            }

            const responseText = this.responseTurnText(turn);
            if (!responseText.toLowerCase().includes('summary')) {
                return false;
            }

            const match = responseText.match(new RegExp(`-\\s*${label}:\\s*(.+)`, 'i'));
            if (!match) {
                return false;
            }

            return !/^(none|n\/a|no relationships|not specified|missing|unknown)\.?$/i.test(match[1].trim());
        }

        return false;
    }

    protected buildInterviewStateInstruction(context: vscode.ChatContext, interviewState: InterviewState): string {
        const availableTools = interviewState.confirmed
            ? 'generateClassDiagram only'
            : 'readUmlFile only';

        const generationRule = interviewState.confirmed
            ? 'The user confirmed a complete prior summary with no missing information. Call biguml-generate-class-diagram exactly once with the complete confirmed diagram. This tool creates or replaces the target .uml file, then creates nodes, members, and relationships in deterministic order. Do not read the file first. Do not output raw UML.'
            : 'The user has not confirmed a complete summary. Do not call createUmlFile, addNode, addClassMember, addRelation, removeNode, or removeRelation. Continue the interview by asking exactly one clear, friendly question, or show the required summary only when no information is missing. You may offer concrete suggestions when useful, but label them as suggestions that the user can accept or change.';

        return `## Interview State
- Phase: ${interviewState.phase}
- Diagram type: CLASS
- Awaiting confirmation: ${interviewState.awaitingConfirmation}
- Confirmed for generation: ${interviewState.confirmed}
- Tools available this turn: ${availableTools}

${generationRule}

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
                        1. Gather class diagram requirements in this order: scope, entities, relationships, details, confirmation.
                        2. Ask exactly one clarifying question per assistant response when information is missing.
                        3. Avoid compound prompts such as multiple bullet questions, "for example" question lists, or several alternatives that all need answers.
                        4. Show the required summary before generation.
                        5. Generate only after explicit confirmation of a previous summary.
                        6. Use registered tools only for generation.`,

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
