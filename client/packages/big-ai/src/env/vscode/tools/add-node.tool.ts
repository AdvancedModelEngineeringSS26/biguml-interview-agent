/*********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 *********************************************************************************/

import { OutputChannel } from '@borkdominik-biguml/big-vscode/vscode';
import { randomUUID } from 'crypto';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import type { AddNodeInput, UmlNodeType } from '../../common/index.js';
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

// Element types that have a visual position/size in the diagram
const BOUNDED_TYPES = new Set<UmlNodeType>([
    'Class', 'AbstractClass', 'Interface', 'Enumeration', 'Package', 'DataType', 'PrimitiveType'
]);

@injectable()
export class AddNodeTool implements vscode.LanguageModelTool<AddNodeInput> {
    constructor(@inject(OutputChannel) protected readonly outputChannel: OutputChannel) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AddNodeInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        void token;

        const { filePath, elementType, name, properties } = options.input;
        this.outputChannel.appendLine(`[big-ai] AddNodeTool: ${elementType} "${name}" -> ${filePath}`);

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

        const existing = diagram.diagram.entities.find(e => e.name === name);
        if (existing) {
            return createToolResult(`Error: An element named "${name}" already exists in the diagram.`);
        }

        const id = generateId();
        const node = buildNode(elementType, id, name, properties);
        diagram.diagram.entities.push(node);

        if (BOUNDED_TYPES.has(elementType)) {
            const entityCount = diagram.diagram.entities.length - 1;
            const { x, y } = autoPosition(entityCount, diagram.metaInfos);
            diagram.metaInfos.push(
                {
                    __type: 'Size',
                    __id: `size_${id}`,
                    height: 30,
                    width: 80,
                    element: { __type: 'Reference', __refType: 'ElementWithSizeAndPosition', __value: id }
                },
                {
                    __type: 'Position',
                    __id: `pos_${id}`,
                    x,
                    y,
                    element: { __type: 'Reference', __refType: 'ElementWithSizeAndPosition', __value: id }
                }
            );
        }

        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(diagram, null, '\t'), 'utf-8'));

        this.outputChannel.appendLine(`[big-ai] Added ${elementType} "${name}" (id: ${id})`);
        return createToolResult(`Added ${elementType} "${name}" (id: ${id}) to ${filePath}`);
    }
}

function generateId(): string {
    const uuid = randomUUID();
    // Prefix with 'a' to match the existing ID format in workspace files
    return `a${uuid.substring(1)}`;
}

function buildNode(elementType: UmlNodeType, id: string, name: string, extra?: Record<string, unknown>): UmlNode {
    const defaults = elementDefaults(elementType);
    return { __type: elementType, __id: id, name, ...defaults, ...extra };
}

function elementDefaults(elementType: UmlNodeType): Record<string, unknown> {
    switch (elementType) {
        case 'Class':
            return { isAbstract: false, properties: [], operations: [], isActive: false, visibility: 'PUBLIC', skip: false };
        case 'AbstractClass':
            return { isAbstract: true, properties: [], operations: [], isActive: false, visibility: 'PUBLIC', skip: false };
        case 'Interface':
            return { properties: [], operations: [] };
        case 'Enumeration':
            return { values: [] };
        case 'Package':
            return { visibility: 'PUBLIC', entities: [] };
        case 'DataType':
            return { properties: [], operations: [], isAbstract: false, visibility: 'PUBLIC' };
        case 'PrimitiveType':
            return {};
    }
}

function autoPosition(entityIndex: number, metaInfos: MetaInfo[]): { x: number; y: number } {
    // Count existing position entries to avoid stacking on top of existing elements
    const positionCount = metaInfos.filter(m => m.__type === 'Position').length;
    const col = positionCount % 4;
    const row = Math.floor(positionCount / 4);
    void entityIndex;
    return { x: 50 + col * 220, y: 50 + row * 160 };
}
