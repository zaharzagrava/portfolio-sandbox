import {
  ASTVisitor,
  FieldNode,
  FragmentDefinitionNode,
  GraphQLError,
  Kind,
  SelectionSetNode,
  ValidationContext,
} from 'graphql';

/**
 * Query cost guard (04/01 §2.6): rejects queries deeper than `maxDepth` or
 * whose estimated cost exceeds `maxCost` BEFORE execution. Cost = 1 per field,
 * multiplied by list sizes the query asks for (`ids` length / `first`), so
 * `products(ids: [50 ids]) { recommendations { shop { ... } } }` is priced as the
 * fan-out it really is.
 */
export function costLimit(maxDepth = 6, maxCost = 2_000) {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const def of context.getDocument().definitions)
      if (def.kind === Kind.FRAGMENT_DEFINITION)
        fragments.set(def.name.value, def);

    const walk = (
      set: SelectionSetNode | undefined,
      depth: number,
      multiplier: number,
    ): { depth: number; cost: number } => {
      if (!set) return { depth, cost: 0 };
      let maxSeen = depth;
      let cost = 0;
      for (const selection of set.selections) {
        if (selection.kind === Kind.FIELD) {
          if (selection.name.value.startsWith('__')) continue;
          const fan = listSize(selection) * multiplier;
          const inner = walk(selection.selectionSet, depth + 1, fan);
          cost += fan + inner.cost;
          maxSeen = Math.max(maxSeen, inner.depth);
        } else {
          const inner = walk(
            selection.kind === Kind.FRAGMENT_SPREAD
              ? fragments.get(selection.name.value)?.selectionSet
              : selection.selectionSet,
            depth,
            multiplier,
          );
          cost += inner.cost;
          maxSeen = Math.max(maxSeen, inner.depth);
        }
      }
      return { depth: maxSeen, cost };
    };

    return {
      OperationDefinition(node) {
        const { depth, cost } = walk(node.selectionSet, 0, 1);
        if (depth > maxDepth)
          context.reportError(
            new GraphQLError(`Query depth ${depth} exceeds ${maxDepth}`),
          );
        if (cost > maxCost)
          context.reportError(
            new GraphQLError(`Query cost ${cost} exceeds ${maxCost}`),
          );
      },
    };
  };
}

function listSize(field: FieldNode): number {
  for (const arg of field.arguments ?? []) {
    if (arg.name.value === 'ids' && arg.value.kind === Kind.LIST)
      return Math.max(arg.value.values.length, 1);
    if (arg.name.value === 'first' && arg.value.kind === Kind.INT)
      return Number(arg.value.value);
  }
  return field.name.value === 'recommendations' ? 6 : 1;
}
