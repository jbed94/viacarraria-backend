import { subject } from '@casl/ability';

import { defineAbilityFor } from './ability.js';

const guest = {
  userId: 'guest-1',
  tier: 'ANONYMOUS' as const,
  email: null,
  username: null,
  isGuest: true,
};

const freeUser = {
  userId: 'user-1',
  tier: 'FREE' as const,
  email: 'user@example.com',
  username: 'User',
  isGuest: false,
};

describe('defineAbilityFor', () => {
  it('allows guests to read and query public graphs only', () => {
    const ability = defineAbilityFor(guest);

    expect(
      ability.can(
        'read',
        subject('Graph', { userId: 'owner', isPublic: true }),
      ),
    ).toBe(true);
    expect(
      ability.can(
        'query',
        subject('Graph', { userId: 'owner', isPublic: true }),
      ),
    ).toBe(true);
    expect(
      ability.can(
        'read',
        subject('Graph', { userId: 'owner', isPublic: false }),
      ),
    ).toBe(false);
    expect(ability.can('create', 'Graph')).toBe(false);
  });

  it('allows registered users to manage only their own graphs and sources', () => {
    const ability = defineAbilityFor(freeUser);

    expect(
      ability.can(
        'update',
        subject('Graph', { userId: 'user-1', isPublic: false }),
      ),
    ).toBe(true);
    expect(
      ability.can(
        'delete',
        subject('Graph', { userId: 'other', isPublic: false }),
      ),
    ).toBe(false);
    expect(ability.can('create', 'Graph')).toBe(true);
    expect(
      ability.can(
        'upload',
        subject('Source', { graphUserId: 'user-1', graphIsPublic: false }),
      ),
    ).toBe(true);
  });
});
