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
import type { RemoveRelationInput } from '../../common/index.js';
import { createToolResult, resolveWorkspacePath } from './tool-utils.js';

interface UmlNode {
    __id: string;
    name: string;
    [key: string]: unknown;
}

interface UmlRelation {
    __type: string;
    __id: string;
    source?: { __value?: string };
    target?: { __value?: string };
    [key: string]: unknown;
}

interface UmlDiagramFile {
    diagram: {
        entities: UmlNode[];
        relations: UmlRelation[];
    };
    metaInfos: unknown[];
}

@injectable()
export class RemoveRelationTool implements vscode.LanguageModelTool<RemoveRelationInput> {
    constructor(@inject(OutputChannel) protected readonly outputChannel: OutputChannel) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RemoveRelationInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        void token;

        const { filePath, sourceName, targetName, relationType } = options.input;
        this.outputChannel.appendLine(`[big-ai] RemoveRelationTool: relation from "${sourceName}" to "${targetName}" in ${filePath}`);

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

        const sourceNode = diagram.diagram.entities.find(e => e.name === sourceName);
        if (!sourceNode) {
            return createToolResult(`Error: No element named "${sourceName}" found in ${filePath}`);
        }

        const targetNode = diagram.diagram.entities.find(e => e.name === targetName);
        if (!targetNode) {
            return createToolResult(`Error: No element named "${targetName}" found in ${filePath}`);
        }

        const index = diagram.diagram.relations.findIndex(r => {
            const srcMatch = r.source?.__value === sourceNode.__id;
            const tgtMatch = r.target?.__value === targetNode.__id;
            const typeMatch = relationType === undefined || r.__type === relationType;
            return srcMatch && tgtMatch && typeMatch;
        });

        if (index === -1) {
            const typeHint = relationType ? ` of type ${relationType}` : '';
            return createToolResult(`Error: No relation${typeHint} from "${sourceName}" to "${targetName}" found in ${filePath}`);
        }

        const [removed] = diagram.diagram.relations.splice(index, 1);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(diagram, null, '\t'), 'utf-8'));

        this.outputChannel.appendLine(`[big-ai] Removed ${removed.__type} from "${sourceName}" to "${targetName}" (id: ${removed.__id})`);
        return createToolResult(`Removed ${removed.__type} from "${sourceName}" to "${targetName}" in ${filePath}`);
    }
}
