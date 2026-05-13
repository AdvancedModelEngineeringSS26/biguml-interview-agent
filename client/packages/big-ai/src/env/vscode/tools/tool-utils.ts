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

export function resolveWorkspacePath(filePath: string): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error('No workspace folder open.');
    }
    const root = folders[0].uri;
    const resolved = vscode.Uri.joinPath(root, filePath);
    if (!resolved.fsPath.startsWith(root.fsPath)) {
        throw new Error(`Path "${filePath}" escapes the workspace root.`);
    }
    return resolved;
}

