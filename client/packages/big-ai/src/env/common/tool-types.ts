/*********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 *********************************************************************************/

export interface DummyToolInput {
    message: string;
}

export type CommandType = 'interview' | 'modify' | 'explain' | 'default';

export interface ParsedCommand {
    type: CommandType;
    argument: string;
}

export type UmlNodeType = 'Class' | 'AbstractClass' | 'Interface' | 'Enumeration' | 'Package' | 'DataType' | 'PrimitiveType';

export type UmlRelationType =
    | 'Association' | 'Aggregation' | 'Composition'
    | 'Abstraction' | 'Dependency' | 'Generalization'
    | 'InterfaceRealization' | 'PackageImport' | 'PackageMerge'
    | 'Realization' | 'Substitution' | 'Usage';

export interface CreateUmlFileInput {
    filePath: string;
    diagramType: 'CLASS';
}

export interface ReadUmlFileInput {
    filePath: string;
}

export interface AddNodeInput {
    filePath: string;
    elementType: UmlNodeType;
    name: string;
    properties?: Record<string, unknown>;
}

export interface RemoveNodeInput {
    filePath: string;
    elementName: string;
}

export interface AddRelationInput {
    filePath: string;
    relationType: UmlRelationType;
    sourceName: string;
    targetName: string;
    name?: string;
    sourceMultiplicity?: string;
    targetMultiplicity?: string;
}

export interface RemoveRelationInput {
    filePath: string;
    sourceName: string;
    targetName: string;
    relationType?: UmlRelationType;
}

