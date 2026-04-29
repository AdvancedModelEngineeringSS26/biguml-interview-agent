/*********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 *********************************************************************************/

import { bindLifecycle, VscodeFeatureModule } from '@borkdominik-biguml/big-vscode/vscode';
import { AiToolRegistry } from './ai-tool-registry.js';
import { InterviewAgentParticipant } from './interview-agent.participant.js';
import { ModelServerClient } from './model-server-client.js';
import { DummyTool } from './tools/index.js';

export function aiModule() {
    return new VscodeFeatureModule(context => {
        context.bind(ModelServerClient).toSelf().inSingletonScope();
        context.bind(DummyTool).toSelf().inSingletonScope();

        bindLifecycle(context, InterviewAgentParticipant);
        bindLifecycle(context, AiToolRegistry);
    });
}
