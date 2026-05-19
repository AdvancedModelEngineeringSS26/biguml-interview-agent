/*********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 *********************************************************************************/

import * as path from 'path';
import * as vscode from 'vscode';

export function createToolResult(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}

export function resolveWorkspacePath(filePath: string, options: { requireUmlExtension?: boolean } = {}): vscode.Uri {
    const normalizedPath = validateRequiredString(filePath, 'filePath');
    if (normalizedPath.includes('\0')) {
        throw new Error('Path contains invalid characters.');
    }
    if (path.isAbsolute(normalizedPath) || /^[a-zA-Z]:[\\/]/.test(normalizedPath)) {
        throw new Error(`Path "${filePath}" must be workspace-relative.`);
    }
    if (options.requireUmlExtension && path.extname(normalizedPath).toLowerCase() !== '.uml') {
        throw new Error(`Path "${filePath}" must point to a .uml file.`);
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error('No workspace folder open.');
    }
    const root = folders[0].uri;
    const rootPath = path.resolve(root.fsPath);
    const resolvedPath = path.resolve(rootPath, normalizedPath);
    if (resolvedPath !== rootPath && !resolvedPath.startsWith(rootPath + path.sep)) {
        throw new Error(`Path "${filePath}" escapes the workspace root.`);
    }
    return vscode.Uri.file(resolvedPath);
}

export function validateRequiredString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} must be a string.`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new Error(`${fieldName} must not be empty.`);
    }
    return trimmed;
}

export function validateUmlDiagramFile(value: unknown): void {
    if (!isRecord(value) || !isRecord(value.diagram)) {
        throw new Error('Invalid UML file: missing diagram object.');
    }
    if (value.diagram.diagramType !== 'CLASS') {
        throw new Error('Invalid UML file: only CLASS diagrams are supported.');
    }
    if (!Array.isArray(value.diagram.entities)) {
        throw new Error('Invalid UML file: diagram.entities must be an array.');
    }
    if (!Array.isArray(value.diagram.relations)) {
        throw new Error('Invalid UML file: diagram.relations must be an array.');
    }
    if (!Array.isArray(value.metaInfos)) {
        throw new Error('Invalid UML file: metaInfos must be an array.');
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
