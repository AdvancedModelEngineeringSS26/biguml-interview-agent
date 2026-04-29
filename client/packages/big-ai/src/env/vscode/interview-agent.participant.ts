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
import { AI_PARTICIPANT_ID } from '../common/index.js';

@injectable()
export class InterviewAgentParticipant implements OnActivate, OnDispose {
    protected participant?: vscode.ChatParticipant;

    onActivate(): void {
        if (!vscode.chat?.createChatParticipant) {
            return;
        }

        this.participant = vscode.chat.createChatParticipant(AI_PARTICIPANT_ID, async (request, context, stream, token) => {
            void token;

            const followupHint =
                context.history.length > 0
                    ? 'You can continue the interview flow or call the dummy AI tool to validate the integration.'
                    : '';

            stream.markdown(
                'The interview agent chat participant is wired up. A dummy AI tool is also registered so the integration can be tested end-to-end.'
            );

            if (request.references.length > 0) {
                stream.markdown(`\n\nI detected ${request.references.length} attached reference(s).`);
            }

            if (followupHint.length > 0) {
                stream.markdown(`\n\n${followupHint}`);
            }

            return {
                metadata: {
                    command: request.command ?? 'default'
                }
            };
        });

        this.participant.followupProvider = {
            provideFollowups: (_result, context, token) => {
                void token;

                if (context.history.length === 0) {
                    return [
                        {
                            prompt: 'I want to create a class diagram',
                            label: 'New Class Diagram'
                        },
                        {
                            prompt: 'Help me modify an existing UML diagram',
                            label: 'Modify Diagram'
                        }
                    ];
                }

                return [
                    {
                        prompt: 'Ask the next clarifying question',
                        label: 'Continue Interview'
                    },
                    {
                        prompt: 'Summarize the current model requirements',
                        label: 'Summarize'
                    }
                ];
            }
        };
    }

    dispose(): void {
        this.participant?.dispose();
        this.participant = undefined;
    }
}
