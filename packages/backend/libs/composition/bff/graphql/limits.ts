import {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  Kind,
  OperationDefinitionNode,
  OperationTypeNode,
  SelectionSetNode,
  ValueNode,
} from 'graphql';

export interface QueryLimits {
  maxDepth: number;
  maxCost: number;
  maxRootFields: number;
  /** Used only to bound what a `first` / `ids` size can multiply; the resolvers reject above it (BAD_USER_INPUT). */
  maxIds: number;
}

export type QueryVerdict = {
  depth: number;
  cost: number;
  rootFields: number;
} & (
  | { ok: true }
  | {
      ok: false;
      code:
        | 'QUERY_TOO_DEEP'
        | 'QUERY_TOO_COSTLY'
        | 'TOO_MANY_ROOT_FIELDS'
        | 'GRAPHQL_VALIDATION_FAILED';
      message: string;
    }
);

/** Items a `recommendations` field is priced at when the query does not say (the S34 envelope is asked for 8). */
export const RECOMMENDATIONS_PRICED_AT = 8;

type Variables = Record<string, unknown>;
interface Measure {
  /** Field levels below (0 for an empty set). */
  depth: number;
  /** Cost at multiplier 1: Σ list size × (1 + cost of the sub-selection). */
  unit: number;
}
class Invalid extends Error {}

/**
 * Pure query analysis (S48 FR-033, AS-31..AS-34). Cost is one unit per field times the sizes of the lists above it;
 * list sizes come from literals and from variable values (and operation default values), `recommendations` counts as
 * 8 unless `first` says otherwise; fragments and inline fragments are priced as the fields they contain. Fragment
 * results are memoised, so a document that spreads fragments into each other is measured in linear time, and a cycle
 * is reported as a validation failure instead of looping.
 */
export function analyzeQuery(
  document: DocumentNode,
  variables: Variables | undefined,
  operationName: string | undefined,
  limits: QueryLimits,
): QueryVerdict {
  const fail = (
    code: Extract<QueryVerdict, { ok: false }>['code'],
    message: string,
    partial: Partial<Measure> & { rootFields?: number } = {},
  ): QueryVerdict => ({
    ok: false,
    code,
    message,
    depth: partial.depth ?? 0,
    cost: partial.unit ?? 0,
    rootFields: partial.rootFields ?? 0,
  });

  const operations = document.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
  );
  const operation = operationName
    ? operations.find((o) => o.name?.value === operationName)
    : operations.length === 1
      ? operations[0]
      : undefined;
  if (!operation)
    return fail(
      'GRAPHQL_VALIDATION_FAILED',
      'Exactly one operation must be selected',
    );
  if (operation.operation !== OperationTypeNode.QUERY)
    return fail(
      'GRAPHQL_VALIDATION_FAILED',
      'Only queries are supported by this endpoint',
    );

  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions)
    if (def.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(def.name.value, def);

  const defaults = new Map<string, unknown>();
  for (const v of operation.variableDefinitions ?? [])
    if (v.defaultValue)
      defaults.set(
        v.variable.name.value,
        literalValue(v.defaultValue, undefined, new Map()),
      );
  const resolve = (name: string): unknown =>
    variables && name in variables ? variables[name] : defaults.get(name);

  const memo = new Map<string, Measure>();
  const visiting = new Set<string>();

  const measureSet = (set: SelectionSetNode | undefined): Measure => {
    if (!set) return { depth: 0, unit: 0 };
    let depth = 0;
    let unit = 0;
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        if (selection.name.value.startsWith('__')) continue;
        const size = listSize(selection, resolve);
        const inner = measureSet(selection.selectionSet);
        depth = Math.max(depth, 1 + inner.depth);
        unit += size * (1 + inner.unit);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        const inner = measureSet(selection.selectionSet);
        depth = Math.max(depth, inner.depth);
        unit += inner.unit;
      } else {
        const name = selection.name.value;
        const def = fragments.get(name);
        if (!def) continue; // validation reports the unknown fragment
        const cached = memo.get(name);
        let inner: Measure;
        if (cached) inner = cached;
        else {
          if (visiting.has(name))
            throw new Invalid(`Fragment "${name}" forms a cycle`);
          visiting.add(name);
          inner = measureSet(def.selectionSet);
          visiting.delete(name);
          memo.set(name, inner);
        }
        depth = Math.max(depth, inner.depth);
        unit += inner.unit;
      }
    }
    return { depth, unit };
  };

  const countRoots = (
    set: SelectionSetNode,
    seen: Set<string> = new Set(),
  ): number => {
    let n = 0;
    for (const s of set.selections) {
      if (s.kind === Kind.FIELD) n += s.name.value.startsWith('__') ? 0 : 1;
      else if (s.kind === Kind.INLINE_FRAGMENT)
        n += countRoots(s.selectionSet, seen);
      else if (!seen.has(s.name.value)) {
        // a fragment spread twice at the root counts twice (it yields its fields twice)
        const def = fragments.get(s.name.value);
        if (def) {
          seen.add(s.name.value);
          n += countRoots(def.selectionSet, seen);
          seen.delete(s.name.value);
        }
      }
    }
    return n;
  };

  let measure: Measure;
  try {
    measure = measureSet(operation.selectionSet);
  } catch (error) {
    if (error instanceof Invalid)
      return fail('GRAPHQL_VALIDATION_FAILED', error.message);
    throw error;
  }
  const rootFields = countRoots(operation.selectionSet);
  const base = { depth: measure.depth, cost: measure.unit, rootFields };

  if (rootFields > limits.maxRootFields)
    return {
      ...base,
      ok: false,
      code: 'TOO_MANY_ROOT_FIELDS',
      message: `Query has ${rootFields} root fields; the maximum is ${limits.maxRootFields}`,
    };
  if (measure.depth > limits.maxDepth)
    return {
      ...base,
      ok: false,
      code: 'QUERY_TOO_DEEP',
      message: `Query depth ${measure.depth} exceeds the maximum of ${limits.maxDepth}`,
    };
  if (measure.unit > limits.maxCost)
    return {
      ...base,
      ok: false,
      code: 'QUERY_TOO_COSTLY',
      message: `Query cost ${measure.unit} exceeds the maximum of ${limits.maxCost}`,
    };
  return { ...base, ok: true };
}

function listSize(
  field: FieldNode,
  resolve: (variable: string) => unknown,
): number {
  for (const arg of field.arguments ?? []) {
    const name = arg.name.value;
    if (name !== 'ids' && name !== 'first') continue;
    const value = literalValue(arg.value, resolve, new Map());
    if (name === 'ids' && Array.isArray(value))
      return Math.max(value.length, 1);
    if (name === 'first' && typeof value === 'number' && Number.isFinite(value))
      return Math.max(Math.floor(value), 1);
  }
  return field.name.value === 'recommendations' ? RECOMMENDATIONS_PRICED_AT : 1;
}

/** Plain value of an argument node, variables resolved; enough to size lists. */
function literalValue(
  node: ValueNode,
  resolve: ((variable: string) => unknown) | undefined,
  _seen: Map<string, unknown>,
): unknown {
  switch (node.kind) {
    case Kind.INT:
    case Kind.FLOAT:
      return Number(node.value);
    case Kind.STRING:
    case Kind.ENUM:
      return node.value;
    case Kind.BOOLEAN:
      return node.value;
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return node.values.map((v) => literalValue(v, resolve, _seen));
    case Kind.OBJECT:
      return Object.fromEntries(
        node.fields.map((f) => [
          f.name.value,
          literalValue(f.value, resolve, _seen),
        ]),
      );
    case Kind.VARIABLE:
      return resolve?.(node.name.value);
    default:
      return undefined;
  }
}
