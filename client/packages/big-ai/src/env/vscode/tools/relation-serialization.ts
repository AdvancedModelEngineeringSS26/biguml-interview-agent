/*********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 *********************************************************************************/

import type { UmlRelationType } from '../../common/index.js';
import { generateId, ref, toParserSafeMultiplicity } from './tool-utils.js';

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

// Aggregation/Composition are aliases of Association distinguished only by the
// source-end aggregation marker. Anything not listed here is not an alias.
const AGGREGATION_KIND: Partial<Record<UmlRelationType, 'SHARED' | 'COMPOSITE'>> = {
    Aggregation: 'SHARED',
    Composition: 'COMPOSITE'
};

// Relation types that carry an optional name in the serialized model.
export const NAMED_RELATION_TYPES = new Set<UmlRelationType>([
    'Association', 'Aggregation', 'Composition', 'Abstraction', 'Dependency',
    'InterfaceRealization', 'Realization', 'Substitution', 'Usage'
]);

export interface RelationRecordParams {
    relationType: UmlRelationType;
    sourceId: string;
    targetId: string;
    name?: string;
    sourceMultiplicity?: string;
    targetMultiplicity?: string;
}

/**
 * Builds the serialized relation record written into a `.uml` diagram file.
 *
 * Aggregation/Composition are emitted as `Association` carrying a `sourceAggregation`
 * marker, since those element types do not exist in the UML grammar.
 */
export function buildRelationRecord(params: RelationRecordParams): Record<string, unknown> {
    const { relationType, sourceId, targetId, name, sourceMultiplicity, targetMultiplicity } = params;

    const aggregationKind = AGGREGATION_KIND[relationType];
    const relation: Record<string, unknown> = {
        __type: aggregationKind ? 'Association' : relationType,
        __id: generateId(),
        source: ref(sourceId),
        target: ref(targetId),
        relationType: aggregationKind ? 'ASSOCIATION' : RELATION_TYPE_MAP[relationType]
    };
    if (aggregationKind) {
        relation['sourceAggregation'] = aggregationKind;
    }

    if (NAMED_RELATION_TYPES.has(relationType) && name !== undefined) {
        relation['name'] = name;
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

    return relation;
}
