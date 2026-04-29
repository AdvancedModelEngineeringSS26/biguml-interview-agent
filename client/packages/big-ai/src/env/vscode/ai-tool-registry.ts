/*********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 *********************************************************************************/

import type { OnActivate, OnDispose } from '@borkdominik-biguml/big-vscode/vscode';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { UML_TOOL_NAMES } from '../common/index.js';
import { DummyTool } from './tools/index.js';

@injectable()
export class AiToolRegistry implements OnActivate, OnDispose {
    protected readonly toDispose: vscode.Disposable[] = [];

    constructor(@inject(DummyTool) protected readonly dummyTool: DummyTool) {}

    onActivate(): void {
        if (!vscode.lm?.registerTool) {
            return;
        }

        this.toDispose.push(vscode.lm.registerTool(UML_TOOL_NAMES.dummy, this.dummyTool));
    }

    dispose(): void {
        this.toDispose.forEach(disposable => disposable.dispose());
        this.toDispose.length = 0;
    }
}
