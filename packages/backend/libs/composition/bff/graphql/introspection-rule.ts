import { ASTVisitor, GraphQLError, ValidationContext } from 'graphql';
import { INTROSPECTION_MESSAGE } from './graphql-errors';

/** Introspection off (production, S48 FR-037): `__schema` and `__type` are refused with a stable code. */
export const noIntrospectionRule = (
  context: ValidationContext,
): ASTVisitor => ({
  Field(node) {
    if (node.name.value === '__schema' || node.name.value === '__type')
      context.reportError(
        new GraphQLError(INTROSPECTION_MESSAGE, {
          nodes: [node],
          extensions: { code: 'INTROSPECTION_DISABLED' },
        }),
      );
  },
});
