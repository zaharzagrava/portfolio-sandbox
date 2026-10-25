import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InviteMemberDto } from './tenancy.dto';

const errorsFor = (email: string) =>
  validate(plainToInstance(InviteMemberDto, { email, role: 'STAFF' }));

describe('InviteMemberDto email (B-060)', () => {
  it('accepts an ordinary address', async () => {
    expect(await errorsFor('Jane@Example.com')).toHaveLength(0);
  });

  it('refuses a lone surrogate, which the database cannot store', async () => {
    expect((await errorsFor('a\uD800b@example.com')).length).toBeGreaterThan(0);
    expect((await errorsFor('a\uDC00@example.com')).length).toBeGreaterThan(0);
  });
});
