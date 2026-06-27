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
import { resolveWorkspacePath } from './tools/tool-utils.js';

// How far back to scan for the most recent proposal when arming the confirmation gate.
// This is a recency bound only — it does not govern how much interview context the model sees.
const MAX_PROPOSAL_LOOKBACK_TURNS = 10;
// Fraction of the model's input window reserved for interview history. The remainder funds the
// system prompt, tool schemas, the current user message, and the model's response.
const HISTORY_TOKEN_BUDGET_FRACTION = 0.5;

type HistoryTurn = vscode.ChatRequestTurn | vscode.ChatResponseTurn;

// Interview uses a tool-driven propose/confirm gate: the model proposes a diagram, then confirms it.
const INTERVIEW_TOOL_NAMES = [UML_TOOL_NAMES.readUmlFile, UML_TOOL_NAMES.proposeDiagram] as const;
const CONFIRMATION_TOOL_NAMES = [UML_TOOL_NAMES.readUmlFile, UML_TOOL_NAMES.proposeDiagram, UML_TOOL_NAMES.confirmGeneration] as const;
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

    // Select as many recent turns as fit the model's token budget, newest -> oldest, so long
    // interviews keep their early requirements instead of being cut at a fixed turn count. History
    // is included twice downstream (the transcript inside the system message and the role-based
    // messages here), so each turn's cost is counted twice against the budget.
    protected async selectHistoryWindow(
        context: vscode.ChatContext,
        model: vscode.LanguageModelChat
    ): Promise<HistoryTurn[]> {
        const budget = Math.floor(model.maxInputTokens * HISTORY_TOKEN_BUDGET_FRACTION);
        const selected: HistoryTurn[] = [];
        let used = 0;

        for (const turn of [...context.history].reverse()) {
            const text = turn instanceof vscode.ChatRequestTurn ? turn.prompt : this.responseTurnText(turn);
            const cost = (await model.countTokens(text)) * 2;
            // Always keep at least the most recent turn, even if it alone exceeds the budget.
            if (used + cost > budget && selected.length > 0) {
                break;
            }
            used += cost;
            selected.unshift(turn);
        }

        return selected;
    }

    protected buildHistoryMessages(history: readonly HistoryTurn[]): vscode.LanguageModelChatMessage[] {
        const messages: vscode.LanguageModelChatMessage[] = [];

        for (const turn of history) {
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

    protected buildInterviewTranscript(history: readonly HistoryTurn[]): string {
        const lines: string[] = [];

        for (const turn of history) {
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
            modify: 'Please apply the requested changes to the current diagram.',
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
        // /modify drives a separate, multi-step editing flow (the mutation tools) instead of the
        // interview's propose/confirm gate.
        const isModify = parsedCommand.type === 'modify' && !interviewState.awaitingConfirmation;
        const allowedToolNames: readonly string[] = isModify
            ? MODIFY_TOOL_NAMES
            : interviewState.awaitingConfirmation
                ? CONFIRMATION_TOOL_NAMES
                : INTERVIEW_TOOL_NAMES;

        this.outputChannel.appendLine(`[big-ai] Request: ${request.prompt}`);
        this.outputChannel.appendLine(`[big-ai] Command type: ${parsedCommand.type}`);
        this.outputChannel.appendLine(`[big-ai] Interview phase: ${interviewState.phase}`);
        this.outputChannel.appendLine(`[big-ai] Awaiting confirmation: ${interviewState.awaitingConfirmation}`);
        this.outputChannel.appendLine(`[big-ai] Conversation turn: ${context.history.length + 1}`);

        const model = await this.selectModel();
        if (!model) {
            stream.markdown(
                '**Error**: No compatible chat model is available. Please ensure GitHub Copilot Chat is installed and authenticated, or adjust `bigUML.ai.modelVendor` / `bigUML.ai.modelFamily` in settings.'
            );
            return {
                metadata: {
                    command: parsedCommand.type,
                    toolUsed: false,
                    error: 'MODEL_UNAVAILABLE'
                }
            };
        }
        this.outputChannel.appendLine(`[big-ai] Using model: ${model.vendor}/${model.family} (${model.name})`);

        const historyWindow = await this.selectHistoryWindow(context, model);
        const referenceMessages = await this.buildReferenceMessages(request);
        // Skip auto-attaching the active diagram on the confirmation turn so its path can't hijack the
        // generation target; the interview transcript / stored proposal is the source of truth there.
        const autoAttachMessages = interviewState.awaitingConfirmation ? [] : await this.buildAutoAttachMessages(request);

        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(this.buildSystemMessage(request, parsedCommand, interviewState, historyWindow)),
            ...this.buildHistoryMessages(historyWindow),
            ...referenceMessages,
            ...autoAttachMessages,
            vscode.LanguageModelChatMessage.User(this.buildUserMessage(request, parsedCommand))
        ];

        let toolUsed = false;
        let responseStreamed = false;
        let presentedProposal: ProposeDiagramInput | undefined;
        let generated = false;
        let modifiedUri: vscode.Uri | undefined;

        try {
            // /modify edits in several steps (create nodes, then relations…), so it needs more rounds.
            const maxIterations = isModify ? 8 : 5;
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
                    // Plain interview/explain turn: the model asked a question or answered. Text already streamed.
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

                // Fire: the model confirms. Generate from the stored proposal, then open the diagram.
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
                    await this.announceGeneration(stream, this.inputFilePath(proposal), toolResult);
                    responseStreamed = true;
                    generated = true;
                    break;
                }

                // Editing / read tools: invoke, return all results together, and remember any edited file
                // so the open diagram can be refreshed once the batch finishes.
                toolUsed = true;
                this.outputChannel.appendLine(`[big-ai] Tool calls collected: ${toolCalls.length}`);
                messages.push(vscode.LanguageModelChatMessage.Assistant(toolCalls));
                // All results for one assistant turn's tool_calls must be returned together in a single
                // tool-result message, or the LM API rejects the next request.
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

                        if (MUTATING_TOOL_NAMES.has(toolCall.name) && !this.toolResultIsError(toolResult)) {
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
                        const msg = toolError instanceof Error ? toolError.message : String(toolError);
                        this.outputChannel.appendLine(`[big-ai] Tool error (${toolCall.name}): ${msg}`);
                        if (token.isCancellationRequested || /cancell?ed/i.test(msg)) {
                            throw toolError;
                        }
                        // Feed the failure back so the model can adjust; every tool_call still needs a result.
                        toolResultParts.push(
                            new vscode.LanguageModelToolResultPart(toolCall.callId, [new vscode.LanguageModelTextPart(`Error: ${msg}`)])
                        );
                    }
                }
                if (toolResultParts.length > 0) {
                    messages.push(vscode.LanguageModelChatMessage.User(toolResultParts));
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

        this.outputChannel.appendLine(
            `[big-ai] Response complete (tool_used: ${toolUsed}, armed: ${presentedProposal !== undefined}, generated: ${generated})`
        );

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

    /** A tool result whose text begins with "error" — the convention the UML tools use to report failure. */
    protected toolResultIsError(toolResult: vscode.LanguageModelToolResult): boolean {
        return this.toolResultText(toolResult).trimStart().toLowerCase().startsWith('error');
    }

    /** The `filePath` field from a tool input / proposal, if present and non-empty. */
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
     * Surface a generation result: stream the tool text, emit a clickable anchor to the generated `.uml`
     * file and open it so the diagram renders. The generation tools only write the file and return text —
     * they never open or anchor it — so without this the run looks like nothing happened.
     */
    protected async announceGeneration(
        stream: vscode.ChatResponseStream,
        filePath: string | undefined,
        toolResult: vscode.LanguageModelToolResult
    ): Promise<void> {
        const resultText = this.toolResultText(toolResult);
        if (resultText.trim()) {
            stream.markdown(resultText);
        }

        if (this.toolResultIsError(toolResult) || !filePath) {
            return;
        }
        let uri: vscode.Uri | undefined;
        try {
            uri = resolveWorkspacePath(filePath.toLowerCase().endsWith('.uml') ? filePath : `${filePath}.uml`);
        } catch {
            return;
        }
        stream.markdown('\n\n✓ Opened ');
        stream.anchor(uri);
        await this.openDiagram(uri);
    }

    /**
     * Open a `.uml` file with its default (bigUML diagram) editor so the generated/edited diagram is visible.
     * The diagram server re-reads the file on open, so an open editor first gets closed to force a fresh load.
     */
    protected async openDiagram(uri: vscode.Uri): Promise<void> {
        try {
            await vscode.commands.executeCommand('vscode.open', uri);
            await this.delay(500);

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
                `[big-ai] Could not open diagram: ${error instanceof Error ? error.message : String(error)}`
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
            return { type: 'interview', argument: interviewMatch[1] || '' };
        }

        const modifyMatch = prompt.match(COMMAND_PATTERNS.modify);
        if (modifyMatch) {
            return { type: 'modify', argument: modifyMatch[1] || '' };
        }

        const explainMatch = prompt.match(COMMAND_PATTERNS.explain);
        if (explainMatch) {
            return { type: 'explain', argument: explainMatch[1] || '' };
        }

        return { type: 'default', argument: prompt };
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
                      { prompt: 'generate', label: 'Generate' },
                      { prompt: '/interview Revise the summary', label: 'Revise summary' },
                      { prompt: '/interview Add missing details', label: 'Add details' }
                  ]
                : [
                      { prompt: '/interview Add the main entities', label: 'Add entities' },
                      { prompt: '/interview Define relationships', label: 'Define relationships' },
                      { prompt: '/interview Add attributes and operations', label: 'Add details' }
                  ],
            modify: [
                { prompt: '/modify Add another class', label: 'Add a class' },
                { prompt: '/modify Add a relationship', label: 'Add a relationship' },
                { prompt: '/explain Why is this a best practice?', label: 'Learn the principle' }
            ],
            explain: [
                { prompt: '/interview How is this applied here?', label: 'See in context' },
                { prompt: '/explain Show a related concept', label: 'Learn more' },
                { prompt: '/modify Apply this pattern', label: 'Use this pattern' }
            ],
            default: [
                { prompt: "/interview Let's analyze this design", label: 'Deep dive' },
                { prompt: '/modify How could we improve this?', label: 'Get suggestions' },
                { prompt: '/explain Clarify a concept', label: 'Learn more' }
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
        const recentHistory = context.history.slice(-MAX_PROPOSAL_LOOKBACK_TURNS);
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

    protected deriveDiagramType(context: vscode.ChatContext, prompt: string, command: ParsedCommand): 'CLASS' | 'DEPLOYMENT' {
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

    protected buildInterviewStateInstruction(
        interviewState: InterviewState,
        command: ParsedCommand,
        history: readonly HistoryTurn[]
    ): string {
        const isModify = command.type === 'modify' && !interviewState.awaitingConfirmation;
        if (isModify) {
            return `## Modify State
- Tools available this turn: readUmlFile, createUmlFile, addNode, addClassMember, removeNode, addRelation, removeRelation

The user wants to change an existing diagram. Apply the change by calling the editing tools — do not just describe it. Pass the active diagram's workspace-relative filePath (shown in Context Information) to every edit tool. If you need the current contents, call biguml-read-uml-file first. Use addNode/addClassMember to add classes and members, removeNode/removeRelation to delete, and addRelation for associations; create all new nodes before relating them. You may batch several independent edits in one turn. Afterwards, briefly state in plain UML terms what you changed (the applied edits are surfaced to the user automatically).

## Chat History Transcript
Use this transcript as the source of truth for requirements. Do not invent missing requirements.

${this.buildInterviewTranscript(history)}`;
        }

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

${this.buildInterviewTranscript(history)}`;
    }

    protected buildSystemMessage(
        request: vscode.ChatRequest,
        command: ParsedCommand,
        interviewState: InterviewState,
        history: readonly HistoryTurn[]
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
                        You are in MODIFY mode. Apply the user's requested changes to the active diagram by calling the editing tools (add/remove nodes, members and relations). Do not just describe the change — make it. Briefly confirm in plain UML terms what you changed.`,

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

${this.buildInterviewStateInstruction(interviewState, command, history)}

---

## Context Information
${referenceInfo}
${activeDiagramInfo}

## Reference Handling
All file paths shown above are workspace-relative. When you call any tool that takes a \`filePath\`, pass the workspace-relative path exactly as shown (e.g. \`class_diagram/Model.uml\`) — never an absolute path or one prefixed with the workspace folder name.

When the user attaches references via chat variables such as \`#file:...\` or \`#selection\`, their content is appended to this conversation as messages labeled \`[Attached reference: <name>]\`. Treat that content as authoritative context.

If a message labeled \`[Auto-attached active UML diagram: <path>]\` appears, the user has that diagram open in their editor; use it as context when the request is about "this diagram" or "the current model".`;
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
            this.outputChannel.appendLine(`[big-ai] Requested model ${vendor}/${family} not available, falling back to any ${vendor} model`);
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

    /**
     * References the user explicitly attached, excluding VS Code's implicit `vscode.*` references
     * (e.g. `vscode.customizations.index`), which add thousands of characters of off-topic noise.
     */
    protected userReferences(request: vscode.ChatRequest): readonly vscode.ChatPromptReference[] {
        return request.references.filter(ref => !ref.id.startsWith('vscode.'));
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
                    continue;
                }
                const { content, source } = resolved;
                const truncated = content.length > MAX_REFERENCE_CHARS;
                const payload = truncated
                    ? `${content.slice(0, MAX_REFERENCE_CHARS)}\n…[truncated, original length: ${content.length} chars]`
                    : content;
                this.outputChannel.appendLine(`[big-ai] Reference ${label} resolved from ${source} (${content.length} chars${truncated ? ', truncated' : ''})`);
                messages.push(
                    vscode.LanguageModelChatMessage.User(`[Attached reference: ${label}${source ? ` (${source})` : ''}]\n${payload}`)
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.outputChannel.appendLine(`[big-ai] Reference ${label} failed to resolve: ${message}`);
                messages.push(vscode.LanguageModelChatMessage.User(`[Attached reference: ${label}]\n(Failed to read content: ${message})`));
            }
        }

        return messages;
    }

    protected async resolveReferenceContent(ref: vscode.ChatPromptReference): Promise<{ content: string; source: string } | undefined> {
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
            this.outputChannel.appendLine(`[big-ai] Auto-attached active UML file ${activeUri.fsPath} (${content.length} chars${truncated ? ', truncated' : ''})`);
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
        return `Attached references (${references.length}):\n${lines.join('\n')}`;
    }

    dispose(): void {
        this.participant?.dispose();
        this.participant = undefined;
        this.outputChannel.appendLine('[big-ai] Interview Agent participant disposed');
    }
}
