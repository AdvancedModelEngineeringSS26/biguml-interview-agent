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
import { resolveWorkspacePath } from './tools/tool-utils.js';
import type { GenerateClassDiagramInput, InterviewPhase, InterviewState, ParsedCommand } from '../common/tool-types.js';

const MAX_HISTORY_TURNS = 10;
const READ_ONLY_TOOL_NAMES = [UML_TOOL_NAMES.readUmlFile] as const;
const GENERATION_TOOL_NAMES = [
    UML_TOOL_NAMES.generateClassDiagram
] as const;
// /modify edits an existing diagram step by step: read it, then add/remove nodes, members and relations.
const MODIFY_TOOL_NAMES = [
    UML_TOOL_NAMES.readUmlFile,
    UML_TOOL_NAMES.createUmlFile,
    UML_TOOL_NAMES.addNode,
    UML_TOOL_NAMES.addClassMember,
    UML_TOOL_NAMES.removeNode,
    UML_TOOL_NAMES.addRelation,
    UML_TOOL_NAMES.removeRelation
] as const;
// Tools that change a .uml file on disk — after these the open diagram is refreshed so edits are visible.
const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
    UML_TOOL_NAMES.createUmlFile,
    UML_TOOL_NAMES.addNode,
    UML_TOOL_NAMES.addClassMember,
    UML_TOOL_NAMES.removeNode,
    UML_TOOL_NAMES.addRelation,
    UML_TOOL_NAMES.removeRelation
]);

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
        const parsedCommand = this.parseCommand(request);
        const interviewState = this.deriveInterviewState(context, request.prompt, parsedCommand);
        const isModify = parsedCommand.type === 'modify' && !interviewState.confirmed;
        const allowedToolNames: readonly string[] = interviewState.confirmed
            ? GENERATION_TOOL_NAMES
            : isModify
                ? MODIFY_TOOL_NAMES
                : READ_ONLY_TOOL_NAMES;

        this.outputChannel.appendLine(`[big-ai] Request: ${request.prompt}`);
        this.outputChannel.appendLine(`[big-ai] Command type: ${parsedCommand.type}`);
        this.outputChannel.appendLine(`[big-ai] Interview phase: ${interviewState.phase}`);
        this.outputChannel.appendLine(`[big-ai] Generation confirmed: ${interviewState.confirmed}`);
        this.outputChannel.appendLine(`[big-ai] Conversation turn: ${context.history.length + 1}`);

        const model = await this.selectModel();
        if (!model) {
            stream.markdown('**Error**: No compatible chat model is available. Please ensure GitHub Copilot Chat is installed and authenticated, or adjust `bigUML.ai.modelVendor` / `bigUML.ai.modelFamily` in settings.');
            return {
                metadata: {
                    command: parsedCommand.type,
                    toolUsed: false,
                    error: 'MODEL_UNAVAILABLE'
                }
            };
        }
        this.outputChannel.appendLine(`[big-ai] Using model: ${model.vendor}/${model.family} (${model.name})`);

        const historyMessages = this.buildHistoryMessages(context);
        const referenceMessages = await this.buildReferenceMessages(request);
        // During the confirmed generation turn, the interview transcript is the source of truth for what to
        // build and where. Skip auto-attaching the active diagram so its path/content can't hijack the target
        // file (e.g. overwrite the open diagram instead of creating the new one discussed in the interview).
        const autoAttachMessages = interviewState.confirmed ? [] : await this.buildAutoAttachMessages(request);

        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(this.buildSystemMessage(request, context, parsedCommand, interviewState)),
            ...historyMessages,
            ...referenceMessages,
            ...autoAttachMessages,
            vscode.LanguageModelChatMessage.User(this.buildUserMessage(request, parsedCommand))
        ];

        let toolUsed = false;
        let responseStreamed = false;
        let streamedText = '';
        const requireToolCalls = interviewState.confirmed;

        if (requireToolCalls) {
            stream.progress('Generating class diagram…');
        }

        let modifiedUri: vscode.Uri | undefined;

        try {
            let generationRetryRequested = false;

            // /modify edits the diagram in several steps (create nodes, then relations…), so it needs more rounds.
            const maxIterations = isModify ? 8 : 3;
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
                        if (!requireToolCalls) {
                            stream.markdown(part.value);
                            streamedText += part.value;
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
                        await this.announceGeneration(stream, this.inputFilePath(generatedInput), toolResult);
                        responseStreamed = true;
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

                // All results for one assistant turn's tool_calls must be returned together in a single
                // tool-result message; pushing them as separate messages makes the LM API reject the next
                // request ("messages with role 'tool' must be a response to a preceding message with 'tool_calls'").
                const toolResultParts: vscode.LanguageModelToolResultPart[] = [];
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
                        toolResultParts.push(new vscode.LanguageModelToolResultPart(toolCall.callId, toolResult.content));

                        // The generation tool writes the .uml file but does not surface or open it, so the run
                        // looks like "nothing happened". Announce the result with a clickable anchor and open it.
                        if (toolCall.name === UML_TOOL_NAMES.generateClassDiagram) {
                            await this.announceGeneration(stream, this.inputFilePath(toolCall.input), toolResult);
                            responseStreamed = true;
                        } else if (MUTATING_TOOL_NAMES.has(toolCall.name) && !this.toolResultIsError(toolResult)) {
                            // Remember the edited file so the open diagram can be refreshed once the batch finishes.
                            const fp = this.inputFilePath(toolCall.input);
                            if (fp) {
                                try {
                                    modifiedUri = resolveWorkspacePath(fp.toLowerCase().endsWith('.uml') ? fp : `${fp}.uml`);
                                } catch {
                                    /* leave modifiedUri unchanged */
                                }
                            }
                        }
                    } catch (toolError) {
                        this.outputChannel.appendLine(`[big-ai] Tool error: ${toolError instanceof Error ? toolError.message : String(toolError)}`);
                        throw toolError;
                    }
                }
                if (toolResultParts.length > 0) {
                    messages.push(vscode.LanguageModelChatMessage.User(toolResultParts));
                }

                // In confirmed/generation mode a single generate call is the whole job. Stop here so the
                // no-tool-call fallback below cannot run a second, redundant generation.
                if (requireToolCalls) {
                    break;
                }
            }
        } catch (error) {
            this.outputChannel.appendLine(`[big-ai] Request error: ${error instanceof Error ? error.message : String(error)}`);
            if (!responseStreamed) {
                stream.markdown(`**Error**: ${error instanceof Error ? error.message : 'Unknown error occurred'}`);
            }
        }

        // After /modify edits, the tools have written the .uml file but the open diagram is stale — anchor the
        // file and reopen it so the changes are visible.
        if (modifiedUri) {
            stream.markdown('\n\n✓ Updated the diagram in ');
            stream.anchor(modifiedUri);
            responseStreamed = true;
            await this.openDiagram(modifiedUri);
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
                generationConfirmed: interviewState.confirmed,
                presentedSummary: this.looksLikeGenerationSummary(streamedText)
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

    /** A tool result whose text begins with "error" — the convention the UML tools use to report failure. */
    protected toolResultIsError(toolResult: vscode.LanguageModelToolResult): boolean {
        return this.toolResultText(toolResult).trimStart().toLowerCase().startsWith('error');
    }

    /** The `filePath` field from a tool input, if present and non-empty. */
    protected inputFilePath(input: unknown): string | undefined {
        if (input && typeof input === 'object' && 'filePath' in input) {
            const value = (input as { filePath?: unknown }).filePath;
            if (typeof value === 'string' && value.trim()) {
                return value.trim();
            }
        }
        return undefined;
    }

    /**
     * Surface the outcome of a generate-class-diagram call: on success, emit a clickable anchor to the
     * generated `.uml` file and open it so the diagram renders; on failure, show the error. The generation
     * tool itself only writes the file and returns text — it never opens or anchors it — so without this the
     * run looks like nothing happened.
     */
    protected async announceGeneration(
        stream: vscode.ChatResponseStream,
        filePath: string | undefined,
        toolResult: vscode.LanguageModelToolResult
    ): Promise<void> {
        const resultText = this.toolResultText(toolResult);
        const errored = resultText.trimStart().toLowerCase().startsWith('error');

        let uri: vscode.Uri | undefined;
        if (filePath) {
            const normalized = filePath.toLowerCase().endsWith('.uml') ? filePath : `${filePath}.uml`;
            try {
                uri = resolveWorkspacePath(normalized);
            } catch {
                uri = undefined;
            }
        }

        if (errored || !uri) {
            stream.markdown(resultText.trim() ? `\n\n${resultText}` : '\n\n**Error**: The diagram could not be generated.');
            return;
        }

        stream.markdown('\n\n✓ Generated the class diagram in ');
        stream.anchor(uri);
        await this.openDiagram(uri);
    }

    /**
     * Open a `.uml` file with its default (bigUML diagram) editor so the generated diagram is visible.
     * The diagram (GLSP) server can race a brand-new file and render a blank canvas (a failed `requestModel`);
     * a manual close+reopen always loads it correctly. We replicate that deterministically: open, let the
     * server pick up the file, then reopen a fresh editor that loads the model.
     */
    protected async openDiagram(uri: vscode.Uri): Promise<void> {
        try {
            await vscode.commands.executeCommand('vscode.open', uri);
            await this.delay(700);

            const tabs = vscode.window.tabGroups.all
                .flatMap(group => group.tabs)
                .filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString());
            if (tabs.length > 0) {
                await vscode.window.tabGroups.close(tabs);
                await this.delay(150);
            }
            await vscode.commands.executeCommand('vscode.open', uri);
        } catch (error) {
            this.outputChannel.appendLine(
                `[big-ai] Could not open generated diagram: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    protected delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    protected parseCommand(request: vscode.ChatRequest): ParsedCommand {
        // VS Code parses a `/command` into request.command and strips it from request.prompt, so this is the
        // authoritative source. Fall back to scanning the prompt for when a command was typed inline.
        if (request.command === 'interview' || request.command === 'modify' || request.command === 'explain') {
            return { type: request.command, argument: request.prompt.trim() };
        }
        return this.parseCommandFromPrompt(request.prompt);
    }

    protected parseCommandFromPrompt(prompt: string): ParsedCommand {
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
        const text = prompt.trim();

        // An explicit request to generate is honored as long as a real interview exchange has happened,
        // even if the assistant's prior summary wording did not match looksLikeGenerationSummary(). Weaker
        // models (e.g. the free Copilot tier) word their summaries differently, so without this the user's
        // explicit "generate" would be silently ignored and only the read-only tool offered.
        const explicitGenerate =
            /^\/?\s*generate\b/i.test(text) ||
            /\b(generate|build|create)\s+(the\s+|a\s+|my\s+)?(class\s+|uml\s+)?(diagram|model|uml)\b/i.test(text);
        if (explicitGenerate && this.hasInterviewExchange(context)) {
            return true;
        }

        // Weaker acknowledgements only confirm right after the assistant explicitly asked to generate.
        if (!this.previousAssistantRequestedGeneration(context)) {
            return false;
        }

        return /\b(generate|create|confirm|confirmed|yes|yep|looks good|go ahead|proceed)\b/i.test(text);
    }

    /** True once the agent has produced at least one response — i.e. a real interview exchange exists. */
    protected hasInterviewExchange(context: vscode.ChatContext): boolean {
        return context.history.some(turn => turn instanceof vscode.ChatResponseTurn);
    }

    protected looksLikeGenerationSummary(text: string): boolean {
        if (!text) {
            return false;
        }

        const hasSummary = /\bsummary\b/i.test(text) || /^\s*-?\s*diagram file:/im.test(text);
        const invitesGeneration =
            /reply\b[\s\S]*?\bgenerate\b/i.test(text) ||
            /\bgenerate\b[\s\S]*?\b(diagram|to create)\b/i.test(text);
        const noMissingInfo =
            /missing info(?:rmation)?:?\s*(none|no\b)/i.test(text) ||
            /\b(nothing|no info\w*)\s+(?:is\s+)?missing\b/i.test(text);

        return hasSummary && invitesGeneration && noMissingInfo;
    }

    protected previousAssistantRequestedGeneration(context: vscode.ChatContext): boolean {
        const recentHistory = context.history.slice(-MAX_HISTORY_TURNS);

        for (const turn of [...recentHistory].reverse()) {
            if (!(turn instanceof vscode.ChatResponseTurn)) {
                continue;
            }

            const recorded = turn.result?.metadata?.presentedSummary;
            if (recorded === true) {
                return true;
            }
            if (recorded === false) {
                // The agent's own non-summary / error turn — skip so it cannot poison the gate.
                continue;
            }

            // Turn predates the recorded flag (or was restored after a reload): use the text heuristic.
            if (this.looksLikeGenerationSummary(this.responseTurnText(turn))) {
                return true;
            }
        }

        return false;
    }

    protected buildInterviewStateInstruction(
        context: vscode.ChatContext,
        interviewState: InterviewState,
        command: ParsedCommand
    ): string {
        const isModify = command.type === 'modify' && !interviewState.confirmed;
        const availableTools = interviewState.confirmed
            ? 'generateClassDiagram only'
            : isModify
                ? 'readUmlFile, addNode, addClassMember, removeNode, addRelation, removeRelation, createUmlFile'
                : 'readUmlFile only';

        const generationRule = interviewState.confirmed
            ? 'The user confirmed a complete prior summary with no missing information. Call biguml-generate-class-diagram exactly once with the complete confirmed diagram. This tool creates or replaces the target .uml file, then creates nodes, members, and relationships in deterministic order. Do not read the file first. Do not output raw UML.\nFor filePath: if the user named a target .uml file during the interview, use exactly that path. Otherwise create a NEW descriptive workspace-relative file named after the diagram subject (e.g. "library-system.uml") — do NOT reuse or overwrite the diagram currently open in the editor.'
            : isModify
                ? 'The user wants to change an existing class diagram. Apply the change by calling the editing tools — do not just describe it. Pass the active diagram\'s workspace-relative filePath (shown in Context Information) to every edit tool. If you need the current contents, call biguml-read-uml-file first. Use addNode/addClassMember to add classes and members, removeNode/removeRelation to delete, and addRelation for associations; create all new nodes before relating them. You may batch several independent edits in one turn. Afterwards, briefly state in plain UML terms what you changed (the applied edits are surfaced to the user automatically).'
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

        const referenceInfo = this.describeReferences(request);
        // On the confirmed generation turn, do NOT advertise the active file as the tool target — otherwise the
        // model overwrites the open diagram instead of creating the new one described in the interview. The
        // generation rule above tells it how to choose the target filePath.
        const activeDiagramInfo = interviewState.confirmed
            ? '- (Generating a new diagram — choose the target file per the generation rule above; do not overwrite the open diagram.)'
            : this.describeActiveDiagram(request);

        return `${SYSTEM_PROMPT}

---

${modeContext}

---

${this.buildInterviewStateInstruction(context, interviewState, command)}

---

## Context Information
${referenceInfo}
${activeDiagramInfo}

## Reference Handling
All file paths shown above are workspace-relative. When you call any tool that takes a \`filePath\`, pass the workspace-relative path exactly as shown (e.g. \`class_diagram/Model.uml\`) — never an absolute path or one prefixed with the workspace folder name.

When the user attaches references via chat variables such as \`#file:...\` or \`#selection\`, their content is appended to this conversation as messages labeled \`[Attached reference: <name>]\`. Treat that content as authoritative context for the user's current request.

If a message labeled \`[Auto-attached active UML diagram: <path>]\` appears, the user has that diagram open in their editor; use it as context when the request is about "this diagram" or "the current model". For a purely conceptual question (e.g. "/explain what is a class diagram"), you may ignore the auto-attached content.`;
}


    // --- #9 Chat references, active-editor context, and configurable model selection ---------------

    /** Pick the chat model from `bigUML.ai.modelVendor`/`modelFamily` with graceful fallback to any available model. */
    protected async selectModel(): Promise<vscode.LanguageModelChat | undefined> {
        const config = vscode.workspace.getConfiguration('bigUML.ai');
        const vendor = config.get<string>('modelVendor')?.trim() || 'copilot';
        const family = config.get<string>('modelFamily')?.trim();

        if (family) {
            const requested = await vscode.lm.selectChatModels({ vendor, family });
            if (requested.length > 0) {
                return requested[0];
            }
            this.outputChannel.appendLine(
                `[big-ai] Requested model ${vendor}/${family} not available, falling back to any ${vendor} model`
            );
        }

        const sameVendor = await vscode.lm.selectChatModels({ vendor });
        if (sameVendor.length > 0) {
            return sameVendor[0];
        }
        const anyModel = await vscode.lm.selectChatModels();
        return anyModel[0];
    }

    /** The active editor's `.uml` file, if any — used to attach the current diagram as implicit context. */
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

    /** Path of a URI relative to the workspace root — the form the tools expect for their `filePath` argument. */
    protected toWorkspaceRelative(uri: vscode.Uri): string {
        return vscode.workspace.asRelativePath(uri, false);
    }

    /**
     * References the user explicitly attached, excluding VS Code's implicit `vscode.*` references
     * (e.g. `vscode.customizations.index`, which injects generic copilot custom-instructions). Those add
     * thousands of characters of off-topic noise that derails small models like the free-tier gpt-4o-mini.
     */
    protected userReferences(request: vscode.ChatRequest): readonly vscode.ChatPromptReference[] {
        return request.references.filter(ref => !ref.id.startsWith('vscode.'));
    }

    protected referenceMatchesUri(ref: vscode.ChatPromptReference, uri: vscode.Uri): boolean {
        const v = ref.value;
        if (v instanceof vscode.Uri) {
            return v.toString() === uri.toString();
        }
        if (v instanceof vscode.Location) {
            return v.uri.toString() === uri.toString();
        }
        return false;
    }

    /** Resolve #file / #selection chat references into labeled context messages. */
    protected async buildReferenceMessages(request: vscode.ChatRequest): Promise<vscode.LanguageModelChatMessage[]> {
        const MAX_REFERENCE_CHARS = 30_000;
        const messages: vscode.LanguageModelChatMessage[] = [];

        for (const ref of this.userReferences(request)) {
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
                    vscode.LanguageModelChatMessage.User(`[Attached reference: ${label}]\n(Failed to read content: ${message})`)
                );
            }
        }

        return messages;
    }

    protected async resolveReferenceContent(
        ref: vscode.ChatPromptReference
    ): Promise<{ content: string; source: string } | undefined> {
        const { value } = ref;

        if (value instanceof vscode.Uri) {
            const bytes = await vscode.workspace.fs.readFile(value);
            return { content: new TextDecoder().decode(bytes), source: this.toWorkspaceRelative(value) };
        }

        if (value instanceof vscode.Location) {
            const document = await vscode.workspace.openTextDocument(value.uri);
            return {
                content: document.getText(value.range),
                source: `${this.toWorkspaceRelative(value.uri)}:${value.range.start.line + 1}-${value.range.end.line + 1}`
            };
        }

        if (typeof value === 'string') {
            return { content: value, source: 'inline' };
        }

        return undefined;
    }

    /** Attach the active `.uml` editor as implicit context unless the user already referenced it explicitly. */
    protected async buildAutoAttachMessages(request: vscode.ChatRequest): Promise<vscode.LanguageModelChatMessage[]> {
        const MAX_CONTENT_CHARS = 30_000;
        const activeUri = this.getActiveUmlUri();
        if (!activeUri) {
            return [];
        }

        const alreadyAttached = request.references.some(ref => this.referenceMatchesUri(ref, activeUri));
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

            const relPath = this.toWorkspaceRelative(activeUri);
            this.outputChannel.appendLine(
                `[big-ai] Auto-attached active UML file ${activeUri.fsPath} (${content.length} chars${truncated ? ', truncated' : ''})`
            );

            return [
                vscode.LanguageModelChatMessage.User(
                    `[Auto-attached active UML diagram: ${relPath}]\n` +
                        `When calling tools that take a filePath, pass exactly this workspace-relative path: "${relPath}".\n` +
                        payload
                )
            ];
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`[big-ai] Failed to auto-attach active UML file: ${message}`);
            return [];
        }
    }

    protected describeActiveDiagram(request: vscode.ChatRequest): string {
        const activeUri = this.getActiveUmlUri();
        if (!activeUri) {
            return '- No active UML diagram detected in the editor.';
        }
        const alreadyAttached = request.references.some(ref => this.referenceMatchesUri(ref, activeUri));
        const relPath = this.toWorkspaceRelative(activeUri);
        return alreadyAttached
            ? `- Active UML diagram in editor: \`${relPath}\` (also explicitly referenced). Use this workspace-relative path for tool calls.`
            : `- Active UML diagram in editor: \`${relPath}\` (auto-attached below). Use this workspace-relative path for tool calls.`;
    }

    protected describeReferences(request: vscode.ChatRequest): string {
        const references = this.userReferences(request);
        if (references.length === 0) {
            return '- No attached references.';
        }

        const lines = references.map(ref => {
            const label = ref.id;
            const { value } = ref;
            if (value instanceof vscode.Uri) {
                return `- ${label} → file: \`${this.toWorkspaceRelative(value)}\``;
            }
            if (value instanceof vscode.Location) {
                const r = value.range;
                return `- ${label} → selection: \`${this.toWorkspaceRelative(value.uri)}\` lines ${r.start.line + 1}-${r.end.line + 1}`;
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
