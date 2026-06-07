/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/
import { isAstNode, isNamed, streamAst } from 'langium';
import { type Diagram } from '../../grammar.js';

/**
 * Returns a unique name within the diagram for the given base `name`.
 *
 * By default a numeric suffix is always appended (`NewClass` -> `NewClass1`), matching the
 * palette's default-name behaviour. Pass `allowBare: true` for explicitly user/AI-supplied names
 * so the requested name is kept as-is when it is free, and only de-duplicated on a real collision
 * (`ShoppingCart` -> `ShoppingCart`, then `ShoppingCart1` if taken).
 */
export function findAvailableNodeName(container: Diagram, name: string, options: { allowBare?: boolean } = {}): string {
    const isTaken = (candidate: string): boolean =>
        !!streamAst(container).find(node => isAstNode(node) && isNamed(node) && node.name === candidate);

    if (options.allowBare && !isTaken(name)) {
        return name;
    }

    let counter = 1;
    while (isTaken(name + counter)) {
        counter++;
    }
    return name + counter;
}
