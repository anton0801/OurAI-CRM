/**
 * Typed filter AST for saved views (section 21): a tree of AND/OR groups with typed clauses —
 * never SQL. The server enforces at most 30 clauses and a nesting depth of 3.
 */
export const FILTER_OPERATOR_LIST = ['equals', 'not_equals', 'in', 'contains', 'before', 'after', 'is_empty', 'is_not_empty'] as const;
export type FilterOperator = (typeof FILTER_OPERATOR_LIST)[number];

export interface FilterClause {
  field: string;
  operator: FilterOperator;
  value?: string | number | boolean | null | (string | number)[];
}
export interface FilterGroup {
  op: 'and' | 'or';
  clauses: (FilterClause | FilterGroup)[];
}

export const MAX_FILTER_CLAUSES = 30;
export const MAX_FILTER_DEPTH = 3;

export type FieldKind = 'text' | 'enum' | 'id' | 'date' | 'boolean' | 'number';

const isGroup = (n: FilterClause | FilterGroup): n is FilterGroup => (n as FilterGroup).clauses !== undefined;

const OPERATORS_BY_KIND: Record<FieldKind, readonly FilterOperator[]> = {
  text: ['equals', 'not_equals', 'contains', 'in', 'is_empty', 'is_not_empty'],
  enum: ['equals', 'not_equals', 'in', 'is_empty', 'is_not_empty'],
  id: ['equals', 'not_equals', 'in', 'is_empty', 'is_not_empty'],
  date: ['equals', 'before', 'after', 'is_empty', 'is_not_empty'],
  boolean: ['equals', 'is_empty', 'is_not_empty'],
  number: ['equals', 'not_equals', 'before', 'after', 'in', 'is_empty', 'is_not_empty'],
};

export interface FilterIssue {
  path: string;
  message: string;
}

/**
 * Validate a filter AST structurally and, when a field allowlist is given, against the fields and
 * operators each field supports. Returns the list of problems (empty when valid).
 */
export const validateFilterAst = (ast: unknown, fields?: Record<string, { kind: FieldKind; values?: readonly string[] }>): FilterIssue[] => {
  const issues: FilterIssue[] = [];
  let clauses = 0;
  const walk = (node: unknown, depth: number, path: string) => {
    if (!node || typeof node !== 'object') {
      issues.push({ path, message: 'Expected a filter group or clause.' });
      return;
    }
    const n = node as FilterClause | FilterGroup;
    if (isGroup(n)) {
      if (depth > MAX_FILTER_DEPTH) {
        issues.push({ path, message: `Filters can be nested at most ${MAX_FILTER_DEPTH} levels deep.` });
        return;
      }
      if (n.op !== 'and' && n.op !== 'or') issues.push({ path: `${path}.op`, message: 'Use "and" or "or".' });
      if (!Array.isArray(n.clauses)) {
        issues.push({ path: `${path}.clauses`, message: 'Expected a list of clauses.' });
        return;
      }
      n.clauses.forEach((c, i) => walk(c, depth + 1, `${path}.clauses.${i}`));
      return;
    }
    clauses++;
    if (typeof n.field !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.]{0,59}$/.test(n.field)) {
      issues.push({ path: `${path}.field`, message: 'Invalid field name.' });
      return;
    }
    if (!(FILTER_OPERATOR_LIST as readonly string[]).includes(n.operator)) {
      issues.push({ path: `${path}.operator`, message: 'Unsupported operator.' });
      return;
    }
    const needsValue = n.operator !== 'is_empty' && n.operator !== 'is_not_empty';
    if (needsValue && (n.value === undefined || n.value === null || n.value === '')) issues.push({ path: `${path}.value`, message: 'This operator needs a value.' });
    if (n.operator === 'in' && !Array.isArray(n.value)) issues.push({ path: `${path}.value`, message: '"in" needs a list of values.' });
    if (n.operator !== 'in' && Array.isArray(n.value)) issues.push({ path: `${path}.value`, message: 'Only "in" accepts a list.' });
    if (fields) {
      const f = fields[n.field];
      if (!f) {
        issues.push({ path: `${path}.field`, message: `Unknown field "${n.field}".` });
        return;
      }
      if (!OPERATORS_BY_KIND[f.kind].includes(n.operator)) issues.push({ path: `${path}.operator`, message: `"${n.operator}" is not available for ${n.field}.` });
      if (f.values && needsValue) {
        const vals = Array.isArray(n.value) ? n.value : [n.value];
        for (const v of vals) if (typeof v !== 'string' || !f.values.includes(v)) issues.push({ path: `${path}.value`, message: `"${String(v)}" is not a valid ${n.field}.` });
      }
      if (f.kind === 'date' && needsValue && (typeof n.value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(n.value))) issues.push({ path: `${path}.value`, message: 'Use an ISO date.' });
      if (f.kind === 'id' && needsValue) {
        const vals = Array.isArray(n.value) ? n.value : [n.value];
        for (const v of vals) if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/i.test(v)) issues.push({ path: `${path}.value`, message: 'Expected a record id.' });
      }
      if (f.kind === 'boolean' && needsValue && typeof n.value !== 'boolean') issues.push({ path: `${path}.value`, message: 'Expected true or false.' });
    }
  };
  walk(ast, 1, 'filterAst');
  if (clauses > MAX_FILTER_CLAUSES) issues.push({ path: 'filterAst', message: `A view can have at most ${MAX_FILTER_CLAUSES} conditions.` });
  return issues;
};

/** Count the clauses of a (valid) AST. */
export const countClauses = (ast: FilterGroup): number => ast.clauses.reduce((n, c) => n + (isGroup(c) ? countClauses(c) : 1), 0);
