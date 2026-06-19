/*********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 *********************************************************************************/

export interface InterviewStepDefinition {
    readonly number: number;
    readonly title: string;
    readonly scopeHint: string;
}

export const INTERVIEW_STEP_DEFINITIONS: readonly InterviewStepDefinition[] = [
    {
        number: 1,
        title: 'Define the UML scope and main entities',
        scopeHint:
            'Ask exactly one question about the name or purpose of the system and what its top-level entities are. ' +
            'Do NOT ask about specific class details, relationships, attributes, or operations yet.'
    },
    {
        number: 2,
        title: 'Model core classes and interfaces',
        scopeHint:
            'Ask exactly one question to clarify the specific class and interface names and whether any are abstract or interfaces. ' +
            'Do NOT ask about relationships, multiplicities, or attributes yet.'
    },
    {
        number: 3,
        title: 'Specify relationships between classes',
        scopeHint:
            'Ask exactly one question about how the classes relate to each other (inheritance, composition, aggregation, association, dependency, etc.). ' +
            'Do NOT ask about multiplicities or attribute details yet.'
    },
    {
        number: 4,
        title: 'Refine associations and multiplicities',
        scopeHint:
            'Ask exactly one question to clarify multiplicity values (e.g. 1..*, 0..1) and any remaining attribute or operation details the user wishes to add. ' +
            'Do NOT revisit scope, class names, or relationship types already collected.'
    },
    {
        number: 5,
        title: 'Confirm and create the diagram',
        scopeHint:
            'List ALL collected information (scope, entities, classes, relationships, multiplicities, attributes) in a concise summary table or list. ' +
            'Then ask exactly: "Shall I create the diagram with these elements?" ' +
            'Do NOT call any tools on this turn. Do not request additional information.'
    },
    {
        number: 6,
        title: 'Review and next steps',
        scopeHint:
            'The diagram has just been created by the extension. Briefly acknowledge the created elements, confirm what was built, and suggest 2–3 possible next steps (add more details, explore other diagram types, add class members, etc.). ' +
            'Keep the response concise and encouraging.'
    }
];

export interface StepRecord {
    readonly definition: InterviewStepDefinition;
    completed: boolean;
    summary: string | undefined;
}

export interface InterviewSession {
    isActive: boolean;
    isCompleted: boolean;
    currentStepIndex: number;
    steps: StepRecord[];
    firstResponseSent: boolean;
    autoCompletedSteps: number[];
}

export class InterviewSessionManager {
    private _session: InterviewSession | null = null;

    get session(): InterviewSession | null {
        return this._session;
    }

    get isActive(): boolean {
        return this._session?.isActive === true;
    }

    get isCompleted(): boolean {
        return this._session?.isCompleted === true;
    }

    get currentStepNumber(): number {
        return (this._session?.currentStepIndex ?? -1) + 1;
    }

    get currentStep(): StepRecord | null {
        if (!this._session) return null;
        return this._session.steps[this._session.currentStepIndex];
    }

    startNew(): InterviewSession {
        this._session = {
            isActive: true,
            isCompleted: false,
            currentStepIndex: 0,
            steps: INTERVIEW_STEP_DEFINITIONS.map(def => ({
                definition: def,
                completed: false,
                summary: undefined
            })),
            firstResponseSent: false,
            autoCompletedSteps: []
        };
        return this._session;
    }

    setAutoCompletedSteps(steps: number[]): void {
        if (this._session) {
            this._session.autoCompletedSteps = steps;
        }
    }

    markFirstResponseSent(): void {
        if (this._session) {
            this._session.firstResponseSent = true;
        }
    }

    completeCurrentStep(summary: string): void {
        if (!this._session || this._session.isCompleted) return;
        const idx = this._session.currentStepIndex;
        this._session.steps[idx].completed = true;
        this._session.steps[idx].summary = summary;
    }

    advanceToNextStep(): void {
        if (!this._session || this._session.isCompleted) return;
        if (this._session.currentStepIndex < 5) {
            this._session.currentStepIndex++;
        }
    }

    markComplete(): void {
        if (!this._session) return;
        this._session.isCompleted = true;
        this._session.isActive = false;
    }

    buildStepHeader(): string {
        if (!this._session) return '';
        const step = this._session.steps[this._session.currentStepIndex];
        const header = `**Step ${step.definition.number} of 6 — ${step.definition.title}**\n\n`;

        const auto = this._session.autoCompletedSteps;
        if (auto.length > 1 && !this._session.firstResponseSent) {
            const lastAuto = auto[auto.length - 1];
            return header + `*Steps 1–${lastAuto} detected from your initial message — jumping ahead.*\n\n`;
        }
        return header;
    }

    buildProgressSummary(): string {
        if (!this._session) return '';

        const session = this._session;
        const currentStep = session.steps[session.currentStepIndex] ?? null;
        const completedSteps = session.steps.filter(step => step.completed && step.summary);
        const remainingSteps = session.steps.filter(step => !step.completed);

        const lines: string[] = ['## Progress Overview', ''];

        if (session.isCompleted) {
            lines.push('**Status:** Interview complete. The diagram has been created.');
        } else if (currentStep) {
            lines.push(`**Current step:** Step ${currentStep.definition.number} of 6 — ${currentStep.definition.title}`);
        }

        lines.push('');
        lines.push('**Completed steps**');
        if (completedSteps.length === 0) {
            lines.push('- None yet');
        } else {
            for (const step of completedSteps) {
                lines.push(`- Step ${step.definition.number}: ${step.definition.title} — ${step.summary}`);
            }
        }

        if (!session.isCompleted) {
            const laterSteps = remainingSteps.filter(step => currentStep && step.definition.number > currentStep.definition.number);
            if (laterSteps.length > 0) {
                lines.push('');
                lines.push('**Remaining steps**');
                for (const step of laterSteps) {
                    lines.push(`- Step ${step.definition.number}: ${step.definition.title}`);
                }
            }

            if (currentStep && currentStep.definition.number < 6) {
                const nextStep = session.steps[currentStep.definition.number];
                if (nextStep) {
                    lines.push('');
                    lines.push(`**Next step after this:** Step ${nextStep.definition.number} — ${nextStep.definition.title}`);
                }
            }
        }

        return `${lines.join('\n')}\n\n`;
    }

    buildPlanTable(): string {
        return this.buildProgressSummary();
    }

    buildCompletionTable(): string {
        return this.buildProgressSummary();
    }

    buildPriorStepsContext(): string {
        if (!this._session) return '';
        const completed = this._session.steps.filter(s => s.completed && s.summary);
        if (completed.length === 0) return '';

        const lines = completed.map(step => `• Step ${step.definition.number} (${step.definition.title}): ${step.summary}`);
        return `## Prior Steps Summary\n\n${lines.join('\n')}\n\n`;
    }

    isConfirmationAnswer(prompt: string): boolean {
        return /\b(generate|create|confirm|confirmed|yes|yep|sure|looks good|go ahead|proceed|do it|make it|ok|okay)\b/i.test(
            prompt
        );
    }
}
