import {
  AbilityBuilder,
  createMongoAbility,
  subject,
  type AnyMongoAbility,
} from '@casl/ability';
import { ForbiddenException, Injectable } from '@nestjs/common';

import type { ViewerIdentity } from '../types.js';

export type AppAction =
  'read' | 'query' | 'create' | 'update' | 'delete' | 'upload' | 'copy';
export type AppSubject = 'Graph' | 'Source';
export type AppAbility = AnyMongoAbility;

export type GraphResource = {
  userId: string;
  isPublic: boolean;
};

export type SourceResource = {
  graphUserId: string;
  graphIsPublic: boolean;
};

export function defineAbilityFor(
  identity: ViewerIdentity | undefined,
): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  can('read', 'Graph', { isPublic: true });
  can('query', 'Graph', { isPublic: true });
  can('copy', 'Graph', { isPublic: true });
  can('read', 'Source', { graphIsPublic: true });

  if (identity) {
    can('read', 'Graph', { userId: identity.userId });
    can('query', 'Graph', { userId: identity.userId });
    can('copy', 'Graph', { userId: identity.userId });
    can('read', 'Source', { graphUserId: identity.userId });

    if (!identity.isGuest) {
      can('create', 'Graph');
      can('update', 'Graph', { userId: identity.userId });
      can('delete', 'Graph', { userId: identity.userId });
      can('upload', 'Source', { graphUserId: identity.userId });
    }
  }

  return build();
}

@Injectable()
export class AuthorizationService {
  can(
    identity: ViewerIdentity | undefined,
    action: AppAction,
    resource: AppSubject,
    value?: GraphResource | SourceResource,
  ): boolean {
    const ability = defineAbilityFor(identity);
    return value
      ? ability.can(action, subject(resource, value))
      : ability.can(action, resource);
  }

  assertCan(
    identity: ViewerIdentity | undefined,
    action: AppAction,
    resource: AppSubject,
    value?: GraphResource | SourceResource,
  ): void {
    if (!this.can(identity, action, resource, value)) {
      throw new ForbiddenException(
        `You are not allowed to ${action} this ${resource.toLowerCase()}.`,
      );
    }
  }
}
