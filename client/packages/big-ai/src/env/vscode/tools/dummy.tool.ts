/*********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 *********************************************************************************/

import { injectable } from 'inversify';
import type * as vscode from 'vscode';
import type { DummyToolInput } from '../../common/index.js';
import { createToolResult } from './tool-utils.js';

@injectable()
export class DummyTool implements vscode.LanguageModelTool<DummyToolInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<DummyToolInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        void token;

        return createToolResult(`Dummy tool invoked with message: ${options.input.message}`);
    }
}
