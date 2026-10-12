/** The roles of a user. Domain vocabulary: `api/` and `application/` import it from here, never from the model. */
export enum Role {
  ADMIN = 'ADMIN',
  MODERATOR = 'MODERATOR',
  SELLER = 'SELLER',
  USER = 'USER',
}
