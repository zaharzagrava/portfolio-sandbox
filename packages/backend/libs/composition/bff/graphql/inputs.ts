import {
  DocumentNode,
  FieldNode,
  Kind,
  SelectionSetNode,
  ValueNode,
} from 'graphql';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InputViolation {
  /** Argument name, without its value. */
  argument: string;
  message: string;
}

const value = (
  node: ValueNode,
  variables: Record<string, unknown>,
  defaults: Map<string, unknown>,
): unknown => {
  switch (node.kind) {
    case Kind.VARIABLE:
      return node.name.value in variables
        ? variables[node.name.value]
        : defaults.get(node.name.value);
    case Kind.LIST:
      return node.values.map((v) => value(v, variables, defaults));
    case Kind.INT:
    case Kind.FLOAT:
      return Number(node.value);
    case Kind.STRING:
    case Kind.ENUM:
    case Kind.BOOLEAN:
      return node.value;
    default:
      return undefined;
  }
};

/**
 * Input bounds (S48 FR-033, AS-34), checked before execution so a violation costs no upstream call and is never
 * "fixed" by truncating: `ids` has at most `maxIds` UUIDs, `first` is 1..`maxIds`, `id` is a UUID. Values are never
 * echoed. Walks every field of every operation and fragment of the document.
 */
export function checkArguments(
  document: DocumentNode,
  variables: Record<string, unknown> | undefined,
  maxIds: number,
): InputViolation | undefined {
  const vars = variables ?? {};
  const defaults = new Map<string, unknown>();
  const fields: FieldNode[] = [];
  const collect = (set: SelectionSetNode | undefined) => {
    for (const s of set?.selections ?? []) {
      if (s.kind === Kind.FIELD) {
        fields.push(s);
        collect(s.selectionSet);
      } else if (s.kind === Kind.INLINE_FRAGMENT) collect(s.selectionSet);
    }
  };
  for (const def of document.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) {
      for (const v of def.variableDefinitions ?? [])
        if (v.defaultValue)
          defaults.set(
            v.variable.name.value,
            value(v.defaultValue, {}, new Map()),
          );
      collect(def.selectionSet);
    } else if (def.kind === Kind.FRAGMENT_DEFINITION) collect(def.selectionSet);
  }
  for (const field of fields) {
    for (const arg of field.arguments ?? []) {
      const v = value(arg.value, vars, defaults);
      switch (arg.name.value) {
        case 'ids':
          if (v === undefined || v === null) break;
          if (!Array.isArray(v))
            return {
              argument: 'ids',
              message: 'Argument "ids" must be a list of ids',
            };
          if (v.length > maxIds)
            return {
              argument: 'ids',
              message: `Argument "ids" accepts at most ${maxIds} items`,
            };
          if (v.some((id) => typeof id !== 'string' || !UUID.test(id)))
            return {
              argument: 'ids',
              message: 'Argument "ids" must contain UUIDs',
            };
          break;
        case 'first':
          if (v === undefined || v === null) break;
          if (
            typeof v !== 'number' ||
            !Number.isInteger(v) ||
            v < 1 ||
            v > maxIds
          )
            return {
              argument: 'first',
              message: `Argument "first" must be an integer from 1 to ${maxIds}`,
            };
          break;
        case 'id':
          if (v === undefined || v === null) break;
          if (typeof v !== 'string' || !UUID.test(v))
            return { argument: 'id', message: 'Argument "id" must be a UUID' };
          break;
      }
    }
  }
  return undefined;
}
