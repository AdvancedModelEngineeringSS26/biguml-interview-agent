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

