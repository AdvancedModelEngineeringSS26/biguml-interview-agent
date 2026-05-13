/*********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 *********************************************************************************/

import { OutputChannel } from '@borkdominik-biguml/big-vscode/vscode';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import type { RemoveNodeInput } from '../../common/index.js';
import { createToolResult, resolveWorkspacePath } from './tool-utils.js';

interface UmlNode {
    __type: string;
    __id: string;
    name: string;
    [key: string]: unknown;
}

interface ClassDiagram {
    __type: 'ClassDiagram';
    __id: string;
    diagramType: 'CLASS';
    entities: UmlNode[];
    relations: UmlNode[];
}

interface MetaInfo {
    __type: string;
    __id: string;
    [key: string]: unknown;
}

interface UmlDiagramFile {
    diagram: ClassDiagram;
    metaInfos: MetaInfo[];
}

@injectable()
export class RemoveNodeTool implements vscode.LanguageModelTool<RemoveNodeInput> {
    constructor(@inject(OutputChannel) protected readonly outputChannel: OutputChannel) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RemoveNodeInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        void token;

        const { filePath, elementName } = options.input;
        this.outputChannel.appendLine(`[big-ai] RemoveNodeTool: "${elementName}" from ${filePath}`);

        let uri: vscode.Uri;
        try {
            uri = resolveWorkspacePath(filePath);
        } catch (e) {
            return createToolResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
        }

        let diagram: UmlDiagramFile;
        try {
            const raw = await vscode.workspace.fs.readFile(uri);
            diagram = JSON.parse(Buffer.from(raw).toString('utf-8')) as UmlDiagramFile;
        } catch {
            return createToolResult(`Error: Could not read or parse file at ${filePath}`);
        }

        const index = diagram.diagram.entities.findIndex(e => e.name === elementName);
        if (index === -1) {
            return createToolResult(`Error: No element named "${elementName}" found in ${filePath}`);
        }

        const elementId = diagram.diagram.entities[index].__id;

        // Try GLSP operation first so the diagram updates immediately
        const glspSuccess = await vscode.commands.executeCommand<boolean>(
            'biguml.operations.deleteElement', filePath, elementId
        );
        if (glspSuccess === true) {
            this.outputChannel.appendLine(`[big-ai] Removed "${elementName}" via GLSP operation`);
            return createToolResult(`Removed "${elementName}" from ${filePath}`);
        }

        // Fallback: write directly to file (diagram not open)
        const [removed] = diagram.diagram.entities.splice(index, 1);
        const removedId = removed.__id;

        diagram.diagram.relations = diagram.diagram.relations.filter(r => {
            const src = (r['source'] as { __value?: string } | undefined)?.__value;
            const tgt = (r['target'] as { __value?: string } | undefined)?.__value;
            return src !== removedId && tgt !== removedId;
        });

        diagram.metaInfos = diagram.metaInfos.filter(
            m => m.__id !== `size_${removedId}` && m.__id !== `pos_${removedId}`
        );

        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(diagram, null, '\t'), 'utf-8'));

        this.outputChannel.appendLine(`[big-ai] Removed "${elementName}" (id: ${removedId}) via file write`);
        return createToolResult(`Removed "${elementName}" from ${filePath}`);
    }
}
