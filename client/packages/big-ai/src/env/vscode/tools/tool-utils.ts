/*********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 *********************************************************************************/

import * as vscode from 'vscode';

export function createToolResult(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
