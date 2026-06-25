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
import { InterviewSessionManager, type StepAdvancementSignal, type InterviewStepPolicy } from './interview-session-manager.js';

const MAX_HISTORY_TURNS = 10;
const NO_TOOL_NAMES: readonly string[] = [];
const GENERATION_TOOL_NAMES = [UML_TOOL_NAMES.generateClassDiagram] as const;
const STATUS_INTENT_PATTERNS: readonly RegExp[] = [
    /\bgive\s+me\s+(a\s+)?summary\b/i,
    /\bshow\s+me\s+(the\s+)?(plan|table|steps)\b/i,
    /\bwhat\s+have\s+we\s+(done|covered)\b/i,
    /\bwhere\s+(are\s+we|do\s+we\s+stand)\b/i,
    /\bsummary\s+of\s+steps\b/i,
    /\bprogress\s+(so\s+far|update)\b/i,
    /\b(current\s+)?status\s+(of|on)\s+(the\s+)?(interview|session|diagram)\b/i,
    /\bshow\s+(current\s+)?progress\b/i,
    /\bplanning\s+mode\b/i
];

function looksLikePlanningRequest(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
        return false;
    }
    return /\b(plan|planning\s+mode|show\s+plan|progress\s+overview)\b/i.test(trimmed);
}

function isGenuineAnswer(command: ParsedCommand, sessionActive: boolean): boolean {
    return command.type === 'default' && sessionActive;
}

function looksLikeStatusRequest(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
        return false;
    }
    return STATUS_INTENT_PATTERNS.some(pattern => pattern.test(trimmed));
}

@injectable()
export class InterviewAgentParticipant implements OnActivate, OnDispose {
    protected participant?: vscode.ChatParticipant;
    protected outputChannel: vscode.OutputChannel;
    protected readonly sessionManager = new InterviewSessionManager();

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

                const clean = this.stripExtensionRenderedContent(responseText);
                if (clean.trim()) {
                    messages.push(vscode.LanguageModelChatMessage.Assistant(clean));
                }
            }
        }
        return messages;
    }

    protected stripExtensionRenderedContent(text: string): string {
        let result = text;

        result = result.replace(/\*\*Step\s+\d+\s+of\s+6\s*[\u2014-][^\n*]*\*\*\s*\n*/gi, '');
        result = result.replace(/\*Steps?\s+\d+[\u2013\u2014-]\d+\s+detected[^\n]*\*\s*\n*/gi, '');
        result = result.replace(/(?:^|\n)\|[^\n]+\|\s*\n\|[\s:|-]+\|(?:\s*\n\|[^\n]+\|)*/g, '');
        result = result.replace(/✅\s*\*\*Interview complete\*\*[^\n]*\n*/gi, '');
        result = result.replace(/Start a new session at any time[^\n]*\n*/gi, '');
        result = result.replace(/No active interview session[^\n]*\n*/gi, '');

        return result.trim();
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
                const responseText = this.stripExtensionRenderedContent(this.responseTurnText(turn));
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

    protected buildUserMessage(request: vscode.ChatRequest, command: ParsedCommand, overridePrompt?: string): string {
        if (overridePrompt !== undefined) {
            return overridePrompt;
        }

        if (command.argument.trim()) {
            return command.argument.trim();
        }

        const defaults: Record<string, string> = {
            interview: 'Please start a requirements interview for a UML class diagram.',
            plan: 'Please show the current interview progress overview.',
            modify: 'Please suggest improvements to the current design.',
            explain: 'Please explain the current UML structure.',
            default: request.prompt
        };

        return defaults[command.type] ?? request.prompt;
    }

    protected isSkipRequest(text: string): boolean {
        return /^(?:\/)?(?:skip|next|continue)(?:\s+(?:this|step|the))?$/i.test(text.trim());
    }

    protected shouldAdvanceCurrentStep(stepPolicy: InterviewStepPolicy | undefined, prompt: string): boolean {
        const normalized = prompt.trim();
        if (!normalized) {
            return false;
        }

        const signals = stepPolicy?.advancementSignals ?? [];
        if (signals.length === 0) {
            return false;
        }

        return signals.some(signal => this.matchesAdvancementSignal(signal, normalized));
    }

    protected matchesAdvancementSignal(signal: StepAdvancementSignal, prompt: string): boolean {
        switch (signal) {
            case 'entity-list':
                return this.hasEntityList(prompt);
            case 'class-declaration':
                return this.hasClassOrInterfaceDeclaration(prompt);
            case 'relationship':
                return this.hasRelationshipSignal(prompt);
            case 'multiplicity-or-details':
                return this.hasMultiplicitySignal(prompt) || this.hasNoAdditionalDetailsSignal(prompt);
            case 'confirmation':
                return this.sessionManager.isConfirmationAnswer(prompt);
            default:
                return false;
        }
    }

    protected hasEntityList(prompt: string): boolean {
        const itemCount = this.countListItems(prompt);
        if (itemCount >= 3 || (/\b(?:entities|classes|interfaces)\b/i.test(prompt) && itemCount >= 2)) {
            return true;
        }

        const stopWords = new Set([
            'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'with', 'in', 'on', 'at', 'by', 'is', 'are', 'was', 'were',
            'be', 'being', 'been', 'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'whose', 'please',
            'main', 'top', 'level', 'system', 'diagram', 'uml', 'create', 'class', 'classes', 'interface', 'interfaces'
        ]);

        const contentWords = prompt
            .toLowerCase()
            .match(/\b[a-z][a-z0-9_-]*\b/g)
            ?.filter(word => !stopWords.has(word)) ?? [];

        return contentWords.length >= 3;
    }

    protected hasClassOrInterfaceDeclaration(prompt: string): boolean {
        return /\b(class|classes|interface|interfaces|abstract|abstract class)\b/i.test(prompt);
    }

    protected hasRelationshipSignal(prompt: string): boolean {
        return /\b(relationship|relates? to|association|aggregation|composition|inheritance|extends|implements|depends on|uses|contains|has|teaches|enrolls? in|owned by|part of)\b/i.test(prompt);
    }

    protected hasMultiplicitySignal(prompt: string): boolean {
        return /\b(\d+\s*\.\.\s*\d+|\d+\s*\.\.\s*\*|\*|one to many|many to one|many to many|one to one|0\.\.1|1\.\.\*|0\.\.\*)\b/i.test(prompt);
    }

    protected hasNoAdditionalDetailsSignal(prompt: string): boolean {
        return /\b(no|none|nothing|nope|skip|empty|leave\s+them\s+empty|no\s+additional\s+(details|attributes)|nothing\s+else)\b/i.test(prompt);
    }

    protected countListItems(prompt: string): number {
        return prompt
            .split(/,|\band\b|\b&\b/i)
            .map(part => part.trim())
            .filter(Boolean).length;
    }

    protected isUncertainAnswer(prompt: string): boolean {
        return /\b(i\s+don'?t\s+know|dont\s+know|not\s+sure|unsure|no\s+idea)\b/i.test(prompt);
    }

    protected normalizeRevisionText(text: string): string {
        const trimmed = text.trim().replace(/\s+/g, ' ');
        if (!trimmed) {
            return '';
        }

        return trimmed.replace(/^\/?(?:interview|plan|modify|explain)\b\s*/i, '');
    }

    protected normalizeIncomingPrompt(prompt: string): string {
        return prompt
            .trim()
            .replace(/^@\w+\s+/i, '')
            .trim();
    }

    protected async handleStepTurn(
        stepNumber: number,
        prompt: string,
        model: vscode.LanguageModelChat,
        token: vscode.CancellationToken
    ): Promise<{ advanced: boolean; generationConfirmed: boolean; summary?: string }> {
        switch (stepNumber) {
            case 1:
                return this.handleScopeStep(prompt, model, token);
            case 2:
                return this.handleClassStep(prompt, model, token);
            case 3:
                return this.handleRelationshipStep(prompt, model, token);
            case 4:
                return this.handleDetailStep(prompt, model, token);
            case 5:
                return this.handleConfirmationStep(prompt);
            default:
                return { advanced: false, generationConfirmed: false };
        }
    }

    protected async handleScopeStep(
        prompt: string,
        _model: vscode.LanguageModelChat,
        _token: vscode.CancellationToken
    ): Promise<{ advanced: boolean; generationConfirmed: boolean; summary?: string }> {
        const parsed = this.sessionManager.applyStepInput(1, prompt);
        const summary = parsed.summary || 'Scope identified';
        this.sessionManager.completeCurrentStep(summary);
        this.sessionManager.advanceToNextStep();
        return { advanced: true, generationConfirmed: false, summary };
    }

    protected async handleClassStep(
        prompt: string,
        _model: vscode.LanguageModelChat,
        _token: vscode.CancellationToken
    ): Promise<{ advanced: boolean; generationConfirmed: boolean; summary?: string }> {
        const parsed = this.sessionManager.applyStepInput(2, prompt);
        const summary = parsed.summary || 'Classes identified';
        this.sessionManager.completeCurrentStep(summary);
        this.sessionManager.advanceToNextStep();
        return { advanced: true, generationConfirmed: false, summary };
    }

    protected async handleRelationshipStep(
        prompt: string,
        _model: vscode.LanguageModelChat,
        _token: vscode.CancellationToken
    ): Promise<{ advanced: boolean; generationConfirmed: boolean; summary?: string }> {
        const parsed = this.sessionManager.applyStepInput(3, prompt);
        const summary = parsed.summary || 'Relationships identified';
        this.sessionManager.completeCurrentStep(summary);
        this.sessionManager.advanceToNextStep();
        return { advanced: true, generationConfirmed: false, summary };
    }

    protected async handleDetailStep(
        prompt: string,
        _model: vscode.LanguageModelChat,
        _token: vscode.CancellationToken
    ): Promise<{ advanced: boolean; generationConfirmed: boolean; summary?: string }> {
        const parsed = this.sessionManager.applyStepInput(4, prompt);
        const summary = parsed.summary || 'Details identified';
        this.sessionManager.completeCurrentStep(summary);
        this.sessionManager.advanceToNextStep();
        return { advanced: true, generationConfirmed: false, summary };
    }

    protected async handleConfirmationStep(
        prompt: string
    ): Promise<{ advanced: boolean; generationConfirmed: boolean; summary?: string }> {
        const isConfirmation = this.sessionManager.isConfirmationAnswer(prompt);
        if (!isConfirmation) {
            return { advanced: false, generationConfirmed: false };
        }

        this.sessionManager.completeCurrentStep('Diagram confirmed');
        this.sessionManager.advanceToNextStep();
        return { advanced: true, generationConfirmed: true, summary: 'Diagram confirmed' };
    }

    protected async handleRequest(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        const parsedCommand = this.parseCommand(request.prompt);
        const statusQuerySource = parsedCommand.type === 'interview' ? parsedCommand.argument : request.prompt;
        const isStatusRequest = looksLikeStatusRequest(statusQuerySource);
        const isPlanningRequest = parsedCommand.type === 'plan' || looksLikePlanningRequest(statusQuerySource);

        const isBareInterview = parsedCommand.type === 'interview' && !parsedCommand.argument.trim();
        const isNewSessionRequest = parsedCommand.type === 'interview' && (!this.sessionManager.isActive || isBareInterview);
        const genuineAnswer = isGenuineAnswer(parsedCommand, this.sessionManager.isActive);
        const skipRequest = this.isSkipRequest(statusQuerySource);
        const currentStepNumberBeforeSkip = this.sessionManager.currentStepNumber;
        const currentStepPolicy = this.sessionManager.currentStep?.definition.policy;
        const canSkipCurrentStep = currentStepPolicy?.canSkip === true;
        const skipApplied = this.sessionManager.isActive && skipRequest && canSkipCurrentStep;
        const skipBlockedAtCurrentStep = this.sessionManager.isActive && skipRequest && !canSkipCurrentStep;

        this.outputChannel.appendLine(`[big-ai] Request: "${request.prompt}"`);
        this.outputChannel.appendLine(`[big-ai] Command type: ${parsedCommand.type}`);
        this.outputChannel.appendLine(`[big-ai] Session active: ${this.sessionManager.isActive}, completed: ${this.sessionManager.isCompleted}`);

        if (isNewSessionRequest && !isStatusRequest) {
            this.sessionManager.startNew();
            this.outputChannel.appendLine('[big-ai] New interview session started');
        }

        if (isStatusRequest || isPlanningRequest) {
            const session = this.sessionManager.session;

            if (this.sessionManager.isCompleted) {
                stream.markdown('✅ **Interview complete** — your diagram has been created.\n\n');
                stream.markdown(this.sessionManager.buildProgressSummary());
            } else if (session?.isActive) {
                stream.markdown(this.sessionManager.buildProgressSummary());
            } else {
                stream.markdown('No active interview session. Start one with `/interview`.');
            }

            return {
                metadata: {
                    command: parsedCommand.type,
                    toolUsed: false,
                    responseStreamed: true,
                    commandArgument: statusQuerySource,
                    statusOnly: true,
                    planningOnly: isPlanningRequest,
                    sessionActive: this.sessionManager.isActive,
                    sessionCompleted: this.sessionManager.isCompleted,
                    currentStepNumber: this.sessionManager.currentStepNumber
                }
            };
        }

        if (skipBlockedAtCurrentStep) {
            const blockedMessage = currentStepPolicy?.skipBlockedMessage ?? 'This step cannot be skipped right now. Please answer the current step question.';
            if (currentStepPolicy?.summaryMode === 'diagram') {
                const summary = this.sessionManager.buildDiagramSummary();
                stream.markdown(summary);
            }
            stream.markdown(`\n${blockedMessage}`);

            return {
                metadata: {
                    command: parsedCommand.type,
                    toolUsed: false,
                    responseStreamed: true,
                    commandArgument: statusQuerySource,
                    sessionActive: this.sessionManager.isActive,
                    sessionCompleted: this.sessionManager.isCompleted,
                    currentStepNumber: this.sessionManager.currentStepNumber,
                    awaitingConfirmation: currentStepPolicy?.summaryMode === 'diagram'
                }
            };
        }

        if (skipApplied) {
            this.sessionManager.advanceToNextStep();
            this.outputChannel.appendLine(`[big-ai] Skipped step ${currentStepNumberBeforeSkip}, advanced to ${this.sessionManager.currentStepNumber}`);
        }

        const activeStepPolicy = this.sessionManager.currentStep?.definition.policy;
        const shouldRenderDiagramSummary = this.sessionManager.isActive
            && activeStepPolicy?.summaryMode === 'diagram'
            && !this.sessionManager.isConfirmationAnswer(request.prompt);

        if (shouldRenderDiagramSummary) {
            const requestedRevision = skipRequest || this.isUncertainAnswer(request.prompt)
                ? undefined
                : this.normalizeRevisionText(statusQuerySource || request.prompt);
            if (requestedRevision) {
                this.sessionManager.applyRevisionToDraft(requestedRevision);
            }
            const summary = this.sessionManager.buildDiagramSummary();
            stream.markdown(summary);
            stream.markdown('Shall I create the diagram with these elements? Reply `yes` to accept or ask for a revision.');

            return {
                metadata: {
                    command: parsedCommand.type,
                    toolUsed: false,
                    responseStreamed: true,
                    commandArgument: statusQuerySource,
                    sessionActive: this.sessionManager.isActive,
                    sessionCompleted: this.sessionManager.isCompleted,
                    currentStepNumber: this.sessionManager.currentStepNumber,
                    awaitingConfirmation: true
                }
            };
        }

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

        let stepAdvancedThisTurn = false;
        let generationConfirmedThisTurn = false;
        let skipAheadCount = 0;

        if (genuineAnswer && this.sessionManager.isActive && !skipApplied) {
            skipAheadCount = await this.runSkipAheadDetection(model, request.prompt, token);
        }

        if (genuineAnswer && this.sessionManager.isActive && skipAheadCount === 0 && !skipApplied) {
            const stepNum = this.sessionManager.currentStepNumber;
            const stepPolicy = this.sessionManager.currentStep?.definition.policy;
            const shouldAdvance = this.shouldAdvanceCurrentStep(stepPolicy, request.prompt);

            const isOnStep5 = stepNum === 5;
            const isConfirmation = this.sessionManager.isConfirmationAnswer(request.prompt);

            this.outputChannel.appendLine(`[big-ai] Genuine answer for step ${stepNum}, confirmation=${isConfirmation}`);

            if (isOnStep5 && !isConfirmation) {
                this.outputChannel.appendLine('[big-ai] Step 5: non-confirmation answer, holding on step 5');
            } else if (stepNum <= 4 && !shouldAdvance) {
                this.outputChannel.appendLine(`[big-ai] Step ${stepNum}: prompt not specific enough, holding on current step`);
            } else {
                const stepResult = await this.handleStepTurn(stepNum, request.prompt, model, token);
                stepAdvancedThisTurn = stepResult.advanced;
                generationConfirmedThisTurn = stepResult.generationConfirmed;

                if (stepResult.summary) {
                    this.outputChannel.appendLine(`[big-ai] Step ${stepNum} summary: ${stepResult.summary}`);
                }

                if (generationConfirmedThisTurn) {
                    this.outputChannel.appendLine('[big-ai] Step 5 confirmed — generation runs on step 6 this turn');
                }

                this.outputChannel.appendLine(`[big-ai] Advanced to step ${this.sessionManager.currentStepNumber}`);
            }
        }

        const stepNum = this.sessionManager.currentStepNumber;
        const isOnStep6 = this.sessionManager.isActive && stepNum === 6;

        const allowedToolNames: readonly string[] = isOnStep6 ? GENERATION_TOOL_NAMES : NO_TOOL_NAMES;
        const requireToolCalls = isOnStep6;

        const interviewState = this.deriveInterviewState(context, request.prompt, parsedCommand);

        this.outputChannel.appendLine(`[big-ai] Step: ${stepNum}, tools: [${allowedToolNames.join(', ')}]`);

        const session = this.sessionManager.session;

        if (this.sessionManager.isCompleted) {
            stream.markdown('✅ **Interview complete** — your diagram has been created.\n\n');
            stream.markdown('Start a new session at any time with `/interview`.\n\n');
        } else if (session?.isActive) {
            stream.markdown(this.sessionManager.buildStepHeader());
        }

        const historyMessages = this.buildHistoryMessages(context);
        const userMessagePrompt = skipApplied ? 'Please continue with the next interview step.' : undefined;

        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(
                this.buildSystemMessage(request, context, parsedCommand, interviewState)
            ),
            ...historyMessages,
            vscode.LanguageModelChatMessage.User(this.buildUserMessage(request, parsedCommand, userMessagePrompt))
        ];

        let toolUsed = false;
        let responseStreamed = false;
        let streamedText = '';

        try {
            let generationRetryRequested = false;
            const maxGenerationIterations = 3;

            for (let iteration = 0; iteration < maxGenerationIterations && !token.isCancellationRequested; iteration++) {
                this.outputChannel.appendLine(`[big-ai] LM request iteration ${iteration + 1}/${maxGenerationIterations}`);

                const response = await model.sendRequest(
                    messages,
                    {
                        tools: vscode.lm.tools.filter(tool =>
                            (allowedToolNames as readonly string[]).includes(tool.name)
                        )
                    },
                    token
                );

                const toolCalls: vscode.LanguageModelToolCallPart[] = [];

                for await (const part of response.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        if (!requireToolCalls) {
                            const normalized = this.stripLeadingStepHeaderEcho(part.value);
                            if (normalized.trim()) {
                                stream.markdown(normalized);
                                streamedText += normalized;
                                responseStreamed = true;
                            }
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
                        this.outputChannel.appendLine('[big-ai] Step 6: no tool call from LLM; deriving aggregate input as JSON');
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
                        this.outputChannel.appendLine('[big-ai] Step 6: generation turn produced text only; showing error');
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
                        this.outputChannel.appendLine(
                            `[big-ai] Tool error: ${toolError instanceof Error ? toolError.message : String(toolError)}`
                        );
                        throw toolError;
                    }
                }
            }
        } catch (error) {
            this.outputChannel.appendLine(
                `[big-ai] Request error: ${error instanceof Error ? error.message : String(error)}`
            );
            if (!responseStreamed) {
                stream.markdown(`**Error**: ${error instanceof Error ? error.message : 'Unknown error occurred'}`);
            }
        }

        this.sessionManager.markFirstResponseSent();

        if (this.sessionManager.isActive && this.sessionManager.currentStepNumber === 6) {
            this.sessionManager.markComplete();
            this.outputChannel.appendLine('[big-ai] Interview session completed after step 6');
        }

        this.outputChannel.appendLine(`[big-ai] Response complete (tool_used: ${toolUsed})`);

        return {
            metadata: {
                command: parsedCommand.type,
                toolUsed,
                responseStreamed,
                commandArgument: parsedCommand.argument || '',
                sessionActive: this.sessionManager.isActive,
                sessionCompleted: this.sessionManager.isCompleted,
                currentStepNumber: this.sessionManager.currentStepNumber,
                stepAdvancedThisTurn,
                generationConfirmedThisTurn,
                interviewPhase: interviewState.phase,
                awaitingConfirmation: this.sessionManager.isActive && this.sessionManager.currentStep?.definition.policy.summaryMode === 'diagram',
                generationConfirmed: isOnStep6,
                presentedSummary: this.looksLikeGenerationSummary(streamedText)
            }
        };
    }

    protected async generateStepSummary(
        _model: vscode.LanguageModelChat,
        stepTitle: string,
        userAnswer: string,
        _token: vscode.CancellationToken
    ): Promise<string> {
        const normalized = this.normalizeStepSummary(userAnswer);
        return normalized || stepTitle;
    }

    protected async runSkipAheadDetection(
        model: vscode.LanguageModelChat,
        content: string,
        token: vscode.CancellationToken
    ): Promise<number> {
        const stepsAnswered = this.analyzeSkipAhead(content);
        const currentStep = this.sessionManager.currentStepNumber; 

        const consecutive: number[] = [];
        for (let i = 0; i < stepsAnswered.length; i++) {
            if (stepsAnswered[i] === currentStep + i) {
                consecutive.push(stepsAnswered[i]);
            } else {
                break;
            }
        }

        const stepsToProcess = consecutive.length > 1 ? consecutive : [];

        for (const stepNumber of stepsToProcess) {
            if (this.sessionManager.currentStepNumber !== stepNumber) break;
            const stepTitle = this.sessionManager.currentStep?.definition.title ?? '';
            const summary = await this.generateStepSummary(model, stepTitle, content, token);
            this.sessionManager.completeCurrentStep(summary);
            this.sessionManager.advanceToNextStep();
        }

        this.sessionManager.setAutoCompletedSteps(stepsToProcess);
        return stepsToProcess.length;
    }

    protected analyzeSkipAhead(
        content: string
    ): number[] {
        const steps: number[] = [];
        const prompt = content.trim();

        if (!prompt) {
            return steps;
        }

        if (this.isExplicitStep1Skip(prompt)) {
            steps.push(1);
        } else {
            return steps;
        }

        if (this.isExplicitStep2Skip(prompt)) {
            steps.push(2);
        } else {
            return steps;
        }

        if (this.isExplicitStep3Skip(prompt)) {
            steps.push(3);
        } else {
            return steps;
        }

        if (this.isExplicitStep4Skip(prompt)) {
            steps.push(4);
        }

        return steps;
    }

    protected normalizeStepSummary(text: string): string {
        const trimmed = text.trim().replace(/\s+/g, ' ');
        if (!trimmed) {
            return '';
        }

        const withoutCommandPrefix = trimmed.replace(/^\/?(?:interview|plan|modify|explain)\b\s*/i, '');
        const firstSentence = withoutCommandPrefix.split(/[.!?]/)[0].trim();
        return (firstSentence || withoutCommandPrefix).slice(0, 100);
    }

    protected isExplicitStep1Skip(prompt: string): boolean {
        const hasDomain = /\b(system|platform|application|app|portal|tool|service|solution|domain|university|course|school|hospital|inventory|library|store|shop|booking)\b/i.test(prompt);
        const entityList = this.extractListItems(prompt);
        return hasDomain && entityList.length >= 2;
    }

    protected isExplicitStep2Skip(prompt: string): boolean {
        if (!/\b(class|classes|interface|interfaces|abstract class|abstract classes)\b/i.test(prompt)) {
            return false;
        }

        const entityList = this.extractListItems(prompt);
        if (entityList.length >= 2) {
            return true;
        }

        const namedTypes = prompt.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [];
        return namedTypes.length >= 2;
    }

    protected isExplicitStep3Skip(prompt: string): boolean {
        const hasRelationshipLanguage = /\b(relationship|relationships|associate(?:d|s|ion)?|aggregate(?:d|s|ion)?|compose(?:d|s|ion)?|inherit(?:ance|s|ed)?|extend(?:s|ed)?|implement(?:s|ed)?|depend(?:s|ed)?|use(?:s|d)?|contain(?:s|ed)?|own(?:s|ed)?|belong(?:s|ed)?|relat(?:e|es|ed|ion)|link(?:s|ed)?|connect(?:s|ed)?)\b/i.test(prompt);
        const entityList = this.extractListItems(prompt);
        return hasRelationshipLanguage && entityList.length >= 2;
    }

    protected isExplicitStep4Skip(prompt: string): boolean {
        const hasMultiplicity = /\b(\d+\s*\.\.\s*\d+|\d+\s*\.\.\s*\*|0\s*\.\.\s*1|1\s*\.\.\s*\*|0\s*\.\.\s*\*|1\s*:\s*\d+|\*\s*:\s*\d+|one to many|many to one|many to many|one to one|optional|exactly one)\b/i.test(prompt);
        const hasRelationshipContext = this.isExplicitStep3Skip(prompt);
        return hasMultiplicity && hasRelationshipContext;
    }

    protected extractListItems(text: string): string[] {
        const match = text.match(/\b(?:with|including|such as|like|consisting of|containing|having|contains|includes|entities?|classes?|interfaces?)\b[:\s]+([^\n.?!]+)/i);
        const source = match?.[1] ?? text;
        return source
            .split(/,|\band\b|;/i)
            .map(item => item.trim())
            .filter(item => item.length > 0);
    }

    protected buildDefaultDiagramFilePath(): string {
        return 'workspace/course_registration.uml';
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

        const parsed = this.parseJsonObject(text) as Partial<GenerateClassDiagramInput>;
        if (!parsed.filePath || !parsed.filePath.trim()) {
            parsed.filePath = this.buildDefaultDiagramFilePath();
        }

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

    protected stripLeadingStepHeaderEcho(text: string): string {
        const session = this.sessionManager.session;
        if (!session?.isActive) {
            return text;
        }

        const current = session.steps[session.currentStepIndex]?.definition;
        if (!current) {
            return text;
        }

        const escapedTitle = current.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const stepHeaderPattern = new RegExp(
            `^\\s*(?:\\*\\*)?Step\\s*${current.number}\\s*of\\s*6\\s*[—-]\\s*${escapedTitle}(?:\\*\\*)?\\s*\\n+`,
            'i'
        );

        let normalized = text;
        while (stepHeaderPattern.test(normalized)) {
            normalized = normalized.replace(stepHeaderPattern, '');
        }

        return normalized;
    }

    protected parseCommand(prompt: string): ParsedCommand {
        const normalizedPrompt = this.normalizeIncomingPrompt(prompt);

        const interviewMatch = normalizedPrompt.match(COMMAND_PATTERNS.interview);
        if (interviewMatch) {
            return {
                type: 'interview',
                argument: interviewMatch[1] || ''
            };
        }

        const modifyMatch = normalizedPrompt.match(COMMAND_PATTERNS.modify);
        if (modifyMatch) {
            return {
                type: 'modify',
                argument: modifyMatch[1] || ''
            };
        }

        const explainMatch = normalizedPrompt.match(COMMAND_PATTERNS.explain);
        if (explainMatch) {
            return {
                type: 'explain',
                argument: explainMatch[1] || ''
            };
        }

        const planMatch = normalizedPrompt.match(COMMAND_PATTERNS.plan);
        if (planMatch) {
            return {
                type: 'plan',
                argument: planMatch[1] || ''
            };
        }

        if (!this.sessionManager.isActive && !this.sessionManager.isCompleted) {
            return {
                type: 'interview',
                argument: normalizedPrompt
            };
        }

        if (this.sessionManager.isCompleted) {
            return {
                type: 'interview',
                argument: normalizedPrompt
            };
        }

        return {
            type: 'default',
            argument: normalizedPrompt
        };
    }

    protected provideFollowups(
        result: vscode.ChatResult,
        _context: vscode.ChatContext,
        _token: vscode.CancellationToken
    ): vscode.ChatFollowup[] {
        const sessionCompleted = result.metadata?.sessionCompleted === true;
        const sessionActive = result.metadata?.sessionActive === true;
        const stepNumber = (result.metadata?.currentStepNumber as number | undefined) ?? 0;

        const interviewFollowup = (label: string, argument: string): vscode.ChatFollowup => ({
            label,
            prompt: argument,
            command: 'interview'
        });

        const planFollowup = (label: string, argument: string): vscode.ChatFollowup => ({
            label,
            prompt: argument,
            command: 'plan'
        });

        if (sessionCompleted) {
            return [planFollowup('📋 Show progress', '/plan'), interviewFollowup('🔄 Start a new interview', 'create a UML class diagram')];
        }

        if (sessionActive) {
            if (stepNumber === 5) {
                return [
                    planFollowup('📋 Show progress', '/plan'),
                    { prompt: 'yes', label: '✅ Accept summary and create the diagram' },
                    interviewFollowup('✏️ Revise summary', 'Please revise the summary')
                ];
            }

            return [
                planFollowup('📋 Show progress', '/plan'),
                interviewFollowup('Get clarification', 'Can you clarify what you mean?'),
                interviewFollowup('Add context', 'Let me add more context')
            ];
        }

        const commandType = (result.metadata?.command ?? 'default') as string;
        const awaitingConfirmation = result.metadata?.awaitingConfirmation === true;

        const followupsByCommand: Record<string, vscode.ChatFollowup[]> = {
            interview: awaitingConfirmation
                ? [
                      planFollowup('📋 Show progress', '/plan'),
                                            { prompt: 'generate', label: '✅ Accept summary and create the diagram' },
                                            interviewFollowup('Revise summary', 'Revise the summary')
                  ]
                : [
                      planFollowup('📋 Show progress', '/plan'),
                      interviewFollowup('▶️ Start interview', 'create a UML class diagram'),
                      interviewFollowup('Add entities', 'Add the main entities'),
                      interviewFollowup('Define relationships', 'Define relationships')
                  ],
            modify: [
                interviewFollowup('Explain improvements', 'How does this improve the design?'),
                { prompt: '/modify Apply another improvement', label: 'More improvements' },
                { prompt: '/explain Why is this a best practice?', label: 'Learn the principle' }
            ],
            explain: [
                interviewFollowup('See in context', 'How is this applied here?'),
                { prompt: '/explain Show a related concept', label: 'Learn more' },
                { prompt: '/modify Apply this pattern', label: 'Use this pattern' }
            ],
            default: [
                planFollowup('📋 Show progress', '/plan'),
                interviewFollowup('▶️ Start interview', 'create a UML class diagram'),
                { prompt: '/modify How could we improve this?', label: 'Get suggestions' },
                { prompt: '/explain Clarify a concept', label: 'Learn more' }
            ]
        };

        return followupsByCommand[commandType] ?? followupsByCommand['default'];
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
                continue;
            }

            if (this.looksLikeGenerationSummary(this.responseTurnText(turn))) {
                return true;
            }
        }

        return false;
    }

    protected buildInterviewStateInstruction(context: vscode.ChatContext, interviewState: InterviewState): string {
        const session = this.sessionManager.session;

        if (!session?.isActive) {
            return this.buildLegacyInterviewStateInstruction(context, interviewState);
        }

        const stepIndex = session.currentStepIndex;
        const step = session.steps[stepIndex];
        const stepNumber = stepIndex + 1;
        const isOnStep5 = stepNumber === 5;
        const isOnStep6 = stepNumber === 6;

        const toolRule = isOnStep6
            ? 'The user confirmed the diagram on the previous turn. Call `biguml-generate-class-diagram` exactly once with ALL confirmed information from the transcript. This tool creates the .uml file and all nodes, members, and relationships in one call. Do not read the file first.'
            : isOnStep5
            ? 'DO NOT call any tools on this turn. Show a diagram-focused summary of what is known so far: scope, entities, classes, relationships, multiplicities, and any additional details already confirmed. Say clearly that step 5 cannot be skipped. Then ask the user to accept the summary or request a revision. Do not ask about later steps.'
            : stepNumber === 2
            ? 'DO NOT call any tools on this turn. Ask exactly one question about the specific class and interface names only. If the user already listed names, briefly acknowledge them and ask whether any are abstract or interfaces. Do NOT ask about relationships, multiplicities, attributes, or operations.'
            : stepNumber === 3
            ? 'DO NOT call any tools on this turn. Ask exactly one question about relationships between the classes only. Do NOT ask about class names, multiplicities, attributes, or operations.'
            : stepNumber === 4
            ? 'DO NOT call any tools on this turn. Ask exactly one question about multiplicities and any remaining attributes or operations only. Do NOT revisit scope, class names, or relationship types.'
            : 'DO NOT call any tools on this turn. Ask exactly one question scoped to this step. Do not ask about content that belongs to a later step.';

        return `## Interview Session — Step ${stepNumber} of 6

**Current step**: ${step.definition.title}

**Step scope instruction**: ${step.definition.scopeHint}

${this.sessionManager.buildPriorStepsContext()}
**IMPORTANT — do NOT repeat the step number or title in your response.** The extension already displays "Step ${stepNumber} of 6 — ${step.definition.title}" as a fixed header above your message. Starting your reply with a similar heading would duplicate it.

**Tools this turn**: ${isOnStep6 ? '`biguml-generate-class-diagram`' : 'none'}

${toolRule}

## Chat History Transcript
Use this as the source of truth for requirements collected so far. Do not invent missing information.
If the last user message is a .uml path, treat it as the target file only — not as attribute or operation detail.
When summarizing step 5, keep it to one compact paragraph or short bullet list and omit any file-path discussion unless the user explicitly supplied one.
Short acknowledgements (yes, ok, sure, use those, sounds good) confirm the concrete items proposed in the immediately preceding assistant turn.

${this.buildInterviewTranscript(context)}`;
    }

    protected buildLegacyInterviewStateInstruction(
        context: vscode.ChatContext,
        interviewState: InterviewState
    ): string {
        const availableTools = interviewState.confirmed
            ? 'generateClassDiagram only'
            : 'readUmlFile only';

        const generationRule = interviewState.confirmed
            ? 'The user confirmed a complete prior summary with no missing information. Call biguml-generate-class-diagram exactly once with the complete confirmed diagram. This tool creates or replaces the target .uml file, then creates nodes, members, and relationships in deterministic order. Do not read the file first. Do not output raw UML.'
            : 'The user has not confirmed a complete summary. Do not call createUmlFile, addNode, addClassMember, addRelation, removeNode, or removeRelation. Continue the interview by asking exactly one clear, friendly question. If you summarize, keep it short and do not mention missing information or the file path unless the user explicitly supplied one.';

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
When summarizing step 5, keep it short and do not mention missing information or the file path unless the user explicitly supplied one.
Only generate attributes or operations that the user explicitly named, explicitly accepted from the previous assistant suggestion, or explicitly requested no details.
Short acknowledgements such as yes, ok, sure, use those, that works, and sounds good confirm the concrete items suggested in the immediately preceding assistant turn.

${this.buildInterviewTranscript(context)}`;
    }

    protected buildSystemMessage(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        command: ParsedCommand,
        interviewState: InterviewState
    ): string {
        const sessionIsActive = this.sessionManager.session?.isActive === true;

        const commandContexts: Record<string, string> = {
            interview: sessionIsActive
                ? `## Interview Mode — Active Session
                    You are guiding the user through a fixed 6-step UML class diagram interview.
                    Each step has a strict scope — do not ask about content belonging to a later step.
                    Ask exactly one focused question per response.
                    Do not offer examples that require multiple answers.`
                : `## Interview Mode Activation
                    You are in INTERVIEW mode. Your goals:
                    1. Gather class diagram requirements in this order: scope, entities, relationships, details, confirmation.
                    2. Ask exactly one clarifying question per assistant response when information is missing.
                    3. Avoid compound prompts such as multiple bullet questions or several alternatives that all need answers.
                    4. Show the required summary before generation.
                    5. Generate only after explicit confirmation of a previous summary.`,

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

        const modeContext = commandContexts[command.type] ?? commandContexts['default'];

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
