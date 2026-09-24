import { AppError } from './errors';

/**
 * Declarative transition table. Each state lists the states it may move to; domain
 * commands call `assertTransition` so a status string can never be edited directly.
 */
export type TransitionTable<S extends string> = Record<S, readonly S[]>;

export const canTransition = <S extends string>(table: TransitionTable<S>, from: S, to: S): boolean =>
  (table[from] ?? []).includes(to);

export const assertTransition = <S extends string>(table: TransitionTable<S>, from: S, to: S, what = 'record'): void => {
  if (!canTransition(table, from, to)) {
    throw new AppError('INVALID_STATE', `This ${what} cannot move from ${from} to ${to}.`, {
      details: { from, to, allowed: table[from] ?? [] },
    });
  }
};
