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
import type { AddRelationInput, UmlRelationType } from '../../common/index.js';
import { createToolResult, resolveWorkspacePath, validateRequiredString, validateUmlDiagramFile } from './tool-utils.js';
import { stringifyUmlDiagramFile } from './uml-file-format.js';

// Maps UmlRelationType to the GLSP element type ID used in CreateEdgeOperation
const GLSP_EDGE_TYPE_ID: Record<UmlRelationType, string> = {
    Association: 'class__Association',
    Aggregation: 'class__aggregation__Association',
    Composition: 'class__composition__Association',
    Abstraction: 'class__Abstraction',
    Dependency: 'class__Dependency',
    Generalization: 'class__Generalization',
    InterfaceRealization: 'class__InterfaceRealization',
    PackageImport: 'class__PackageImport',
    PackageMerge: 'class__PackageMerge',
    Realization: 'class__Realization',
    Substitution: 'class__Substitution',
    Usage: 'class__Usage'
};

// Maps UmlRelationType to the relationType field stored in the JSON file
const RELATION_TYPE_MAP: Record<UmlRelationType, string> = {
    Association: 'ASSOCIATION',
    Aggregation: 'AGGREGATION',
    Composition: 'COMPOSITION',
    Abstraction: 'ABSTRACTION',
    Dependency: 'DEPENDENCY',
    Generalization: 'GENERALIZATION',
    InterfaceRealization: 'INTERFACE_REALIZATION',
    PackageImport: 'PACKAGE_IMPORT',
    PackageMerge: 'PACKAGE_MERGE',
    Realization: 'REALIZATION',
    Substitution: 'SUBSTITUTION',
    Usage: 'USAGE'
};

const MULTIPLICITY_TYPES = new Set<UmlRelationType>(['Association', 'Aggregation', 'Composition']);

const NAMED_TYPES = new Set<UmlRelationType>([
    'Association', 'Aggregation', 'Composition', 'Abstraction', 'Dependency',
    'InterfaceRealization', 'Realization', 'Substitution', 'Usage'
]);

interface UmlNode {
    __id: string;
    name: string;
    [key: string]: unknown;
}

interface UmlDiagramFile {
    diagram: {
        entities: UmlNode[];
        relations: Record<string, unknown>[];
    };
    metaInfos: unknown[];
}

@injectable()
export class AddRelationTool implements vscode.LanguageModelTool<AddRelationInput> {
    constructor(@inject(OutputChannel) protected readonly outputChannel: OutputChannel) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AddRelationInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        void token;

        const { filePath, relationType, sourceName, targetName, name, sourceMultiplicity, targetMultiplicity } = options.input;
        this.outputChannel.appendLine(`[big-ai] AddRelationTool: ${relationType} from "${sourceName}" to "${targetName}" in ${filePath}`);

        let sourceElementName: string;
        let targetElementName: string;
        let relationName: string | undefined;
        let uri: vscode.Uri;
        try {
            sourceElementName = validateRequiredString(sourceName, 'sourceName');
            targetElementName = validateRequiredString(targetName, 'targetName');
            relationName = name === undefined ? undefined : validateRequiredString(name, 'name');
            if (!Object.prototype.hasOwnProperty.call(GLSP_EDGE_TYPE_ID, relationType)) {
                throw new Error(`Unsupported relationType "${String(relationType)}".`);
            }
            if (sourceMultiplicity !== undefined) validateRequiredString(sourceMultiplicity, 'sourceMultiplicity');
            if (targetMultiplicity !== undefined) validateRequiredString(targetMultiplicity, 'targetMultiplicity');
            uri = resolveWorkspacePath(filePath, { requireUmlExtension: true });
        } catch (e) {
            return createToolResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
        }

        let diagram: UmlDiagramFile;
        try {
            const raw = await vscode.workspace.fs.readFile(uri);
            const parsed = JSON.parse(Buffer.from(raw).toString('utf-8'));
            validateUmlDiagramFile(parsed);
            diagram = parsed as UmlDiagramFile;
        } catch (e) {
            return createToolResult(`Error: Could not read or parse file at ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
        }

        const sourceNode = diagram.diagram.entities.find(e => e.name === sourceElementName);
        if (!sourceNode) {
            return createToolResult(`Error: No element named "${sourceElementName}" found in ${filePath}`);
        }

        const targetNode = diagram.diagram.entities.find(e => e.name === targetElementName);
        if (!targetNode) {
            return createToolResult(`Error: No element named "${targetElementName}" found in ${filePath}`);
        }

        // Try GLSP operation first so the diagram updates immediately
        const elementTypeId = GLSP_EDGE_TYPE_ID[relationType];
        const glspSuccess = await vscode.commands.executeCommand<boolean>(
            'biguml.operations.createEdge', filePath, elementTypeId, sourceNode.__id, targetNode.__id,
            NAMED_TYPES.has(relationType) ? relationName : undefined
        );
        if (glspSuccess === true) {
            this.outputChannel.appendLine(`[big-ai] Added ${relationType} from "${sourceElementName}" to "${targetElementName}" via GLSP operation`);
            return createToolResult(`Added ${relationType} from "${sourceElementName}" to "${targetElementName}" in ${filePath}`);
        }

        // Fallback: write directly to file (diagram not open)
        const id = generateId();
        const ref = (nodeId: string) => ({ __type: 'Reference', __refType: 'Node', __value: nodeId });

        const relation: Record<string, unknown> = {
            __type: relationType,
            __id: id,
            source: ref(sourceNode.__id),
            target: ref(targetNode.__id),
            relationType: RELATION_TYPE_MAP[relationType]
        };

        if (NAMED_TYPES.has(relationType) && relationName !== undefined) {
            relation['name'] = relationName;
        }

        if (MULTIPLICITY_TYPES.has(relationType)) {
            const safeSourceMultiplicity = sourceMultiplicity === undefined ? undefined : toParserSafeMultiplicity(sourceMultiplicity);
            const safeTargetMultiplicity = targetMultiplicity === undefined ? undefined : toParserSafeMultiplicity(targetMultiplicity);
            if (safeSourceMultiplicity !== undefined) relation['sourceMultiplicity'] = safeSourceMultiplicity;
            if (safeTargetMultiplicity !== undefined) relation['targetMultiplicity'] = safeTargetMultiplicity;
        }

        if (relationType === 'Generalization') {
            relation['isSubstitutable'] = false;
        }

        diagram.diagram.relations.push(relation);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(stringifyUmlDiagramFile(diagram), 'utf-8'));

        this.outputChannel.appendLine(`[big-ai] Added ${relationType} from "${sourceElementName}" to "${targetElementName}" (id: ${id}) via file write`);
        return createToolResult(`Added ${relationType} from "${sourceElementName}" to "${targetElementName}" (id: ${id}) in ${filePath}`);
    }
}

function generateId(): string {
    const uuid = randomUUID();
    return `a${uuid.substring(1)}`;
}

function toParserSafeMultiplicity(value: string): string | undefined {
    const trimmed = value.trim();
    if (trimmed === '*') {
        return trimmed;
    }
    if (/^[a-zA-Z_][\w-]*$/.test(trimmed)) {
        return trimmed;
    }
    switch (trimmed) {
        case '1':
            return 'one';
        case '0..1':
            return 'zeroToOne';
        case '0..*':
        case '*':
            return '*';
        case '1..*':
            return 'oneToMany';
        default:
            return undefined;
    }
}
