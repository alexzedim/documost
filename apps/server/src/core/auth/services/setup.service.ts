import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@wiki/db/types/kysely.types';
import { SpaceService } from 'src/core/space/services/space.service';
import { SpaceMemberRepo } from '@wiki/db/repos/space/space-member.repo';
import { SpaceRepo } from '@wiki/db/repos/space/space.repo';
import { EnvironmentService } from 'src/integrations/environment/environment.service';
import {
  generateSlugId,
  extractUsernameAndSpaceName,
  slugifySpace,
  toCapitalCase,
} from 'src/common/helpers';
import { User } from '@wiki/db/types/entity.types';
import {
  KEYCLOAK_ROLE_SPLITTER,
  SPACE_ROLE_SPLITTER,
} from 'src/common/constants/keycloak.const';
import {
  isValidKeycloakRoleString,
  isValidParsedKeycloakRole,
} from 'src/common/guards/keycloak-role.guard';
import { SpaceRole } from 'src/common/helpers/types/permission';
import {
  KeycloakRole,
  ParsedKeycloakRole,
} from 'src/core/auth/dto/keycloak-payload';

@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    private readonly spaceService: SpaceService,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly spaceRepo: SpaceRepo,
    private readonly environmentService: EnvironmentService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  /**
   * Initialize user personal space
   * Checks if the user has a personal space (system space with name matching their username namespace)
   * Creates one if it doesn't exist
   * @param user - User entity
   * @param workspaceId - Workspace ID
   */
  async setupPersonalSpace(user: User, workspaceId: string): Promise<void> {
    const { namespace } = extractUsernameAndSpaceName(user.name);

    // Check if user already has a personal space (system space with matching name)
    const existingPersonalSpace = await this.db
      .selectFrom('spaces')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('name', 'ilike', namespace)
      .where('isSystem', '=', false)
      .executeTakeFirst();

    if (existingPersonalSpace) {
      this.logger.debug({
        message: 'Personal space already exists for user',
        userId: user.id,
        spaceId: existingPersonalSpace.id,
        spaceName: existingPersonalSpace.name,
      });
      return;
    }

    // Create personal space for user
    this.logger.debug({
      message: 'Creating personal space for user',
      userId: user.id,
      namespace: namespace,
    });

    await this.spaceService.createSpace(user, workspaceId, {
      name: namespace,
      slug: generateSlugId(),
      isSystem: true,
    });

    this.logger.debug({
      message: 'Personal space created successfully for user',
      userId: user.id,
      namespace: namespace,
    });
  }

  /**
   * Parse Keycloak roles from role strings
   * Role string format: PREFIX__SPACE_NAME-ROLE
   * Example: biz-komm-ai__mySpace-admin
   *
   * @param roles - Array of role strings from Keycloak token
   * @returns Array of parsed roles with space name and role
   */
  parseKeycloakRole(roles: string[] | undefined): ParsedKeycloakRole[] {
    if (!roles || !Array.isArray(roles) || roles.length === 0) {
      return [];
    }

    const parsedRoles: ParsedKeycloakRole[] = [];

    const ALLOWED_PREFIX = this.environmentService.getKeyclockWikiRolePrefix();

    for (const roleString of roles) {
      // Validate role string format
      if (!isValidKeycloakRoleString(roleString, ALLOWED_PREFIX)) {
        continue;
      }

      // Split by keycloak role splitter (e.g., '__')
      const [_prefix, suffix] = roleString.split(KEYCLOAK_ROLE_SPLITTER);

      // Split suffix by space role splitter (e.g., '-')
      // Note: space name can contain dashes, so we need to find the last dash
      const lastDashIndex = suffix.lastIndexOf(SPACE_ROLE_SPLITTER);
      if (lastDashIndex === -1) {
        continue;
      }

      const spaceName = suffix.substring(0, lastDashIndex);
      const role = suffix.substring(lastDashIndex + 1) as KeycloakRole;

      // Build parsed role object
      const parsedRole: ParsedKeycloakRole = {
        space: spaceName,
        role: role,
      };

      // Validate parsed role
      if (isValidParsedKeycloakRole(parsedRole)) {
        parsedRoles.push(parsedRole);
      }
    }

    return parsedRoles;
  }

  /**
   * Map Keycloak role to wiki SpaceRole
   * @param keycloakRole - Keycloak role enum value
   * @returns Corresponding SpaceRole value
   */
  mapKeycloakRoleToSpaceRole(keycloakRole: KeycloakRole): SpaceRole {
    switch (keycloakRole) {
      case KeycloakRole.OWNER:
      case KeycloakRole.ADMIN:
        return SpaceRole.ADMIN;
      case KeycloakRole.EDITOR:
        return SpaceRole.WRITER;
      case KeycloakRole.NORMAL:
      default:
        return SpaceRole.READER;
    }
  }

  /**
   * Initialize user space memberships based on parsed Keycloak roles
   * Creates spaces for OWNER/ADMIN roles if they don't exist
   * @param user - User entity
   * @param parsedRoles - Array of parsed Keycloak roles
   * @param workspaceId - Workspace ID
   */
  async setupUserSpaceMemberships(
    user: User,
    parsedRoles: ParsedKeycloakRole[],
    workspaceId: string,
  ): Promise<void> {
    for (const parsedRole of parsedRoles) {
      try {
        const spaceName = toCapitalCase(parsedRole.space);
        const spaceSlug = slugifySpace(parsedRole.space);
        // Find space by slug within workspace (exact match)
        // Also check name with case-insensitive matching for backward compatibility
        let space = await this.db
          .selectFrom('spaces')
          .selectAll()
          .where('workspaceId', '=', workspaceId)
          .where((eb) =>
            eb.or([
              eb('slug', '=', spaceSlug),
              eb('name', 'ilike', spaceName),
            ]),
          )
          .executeTakeFirst();

        if (!space) {
          // Space doesn't exist - check if user can create it
          if (parsedRole.role === KeycloakRole.OWNER) {
            // Create space with user as creator (will auto-add as admin)
            space = await this.spaceService.createSpace(user, workspaceId, {
              name: spaceName,
              slug: spaceSlug,
              isSystem: true,
            });

            this.logger.debug({
              message: 'Created space from Keycloak role',
              spaceName: spaceName,
              spaceId: space.id,
              userId: user.id,
            });
            // Space creation handles membership automatically, continue to next role
            continue;
          } else {
            this.logger.debug({
              message:
                'Space not found and user cannot create it (non-owner/admin role)',
              spaceName: parsedRole.space,
              userRole: parsedRole.role,
              userId: user.id,
            });
            continue;
          }
        }

        // Space exists - create/update membership
        const existingMembership =
          await this.spaceMemberRepo.getSpaceMemberByTypeId(space.id, {
            userId: user.id,
          });

        const spaceRole = this.mapKeycloakRoleToSpaceRole(parsedRole.role);

        if (existingMembership) {
          // Update existing membership role if different
          if (existingMembership.role !== spaceRole) {
            await this.spaceMemberRepo.updateSpaceMember(
              { role: spaceRole },
              existingMembership.id,
              space.id,
            );
            this.logger.debug({
              message: 'Updated space membership from Keycloak role',
              userId: user.id,
              spaceId: space.id,
              spaceName: space.name,
              newRole: spaceRole,
            });
          }
        } else {
          // Create new membership
          await this.spaceMemberRepo.insertSpaceMember({
            userId: user.id,
            spaceId: space.id,
            role: spaceRole,
          });

          this.logger.debug({
            message: 'Created space membership from Keycloak role',
            userId: user.id,
            spaceId: space.id,
            spaceName: space.name,
            role: spaceRole,
          });
        }
      } catch (error) {
        this.logger.warn({
          message: 'Failed to set up space membership from Keycloak role',
          userId: user.id,
          spaceName: parsedRole.space,
          role: parsedRole.role,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Synchronize user space roles by removing memberships that no longer exist in parsedRoles
   * Uses slug-based matching for consistency with setupUserSpaceMemberships
   * @param userId - User ID to sync roles for
   * @param workspaceId - Workspace ID
   * @param parsedRoles - Array of parsed roles from Keycloak
   */
  async syncUserSpaceRoles(
    userId: string,
    workspaceId: string,
    parsedRoles: ParsedKeycloakRole[],
  ): Promise<void> {
    try {
      // Get all spaces in the workspace to map space IDs to space slugs
      const spaces = await this.db
        .selectFrom('spaces')
        .select(['id', 'slug'])
        .where('workspaceId', '=', workspaceId)
        .execute();

      // Create a map of space ID to space slug for quick lookup
      const spaceIdToSlugMap = new Map<string, string>();
      for (const space of spaces) {
        spaceIdToSlugMap.set(space.id, space.slug);
      }

      // Create a set of expected space slugs from parsedRoles using slugifySpace
      const expectedSpaceSlugs = new Set(
        parsedRoles.map((role) => slugifySpace(role.space)),
      );

      // Get all space memberships for the user in the workspace
      const memberships = await this.db
        .selectFrom('spaceMembers')
        .selectAll()
        .where('userId', '=', userId)
        .execute();

      // Find and remove memberships that are not in the expected roles
      for (const membership of memberships) {
        const spaceSlug = spaceIdToSlugMap.get(membership.spaceId);

        // If space exists in workspace and its slug is not in expected roles, remove membership
        if (spaceSlug && !expectedSpaceSlugs.has(spaceSlug)) {
          await this.spaceMemberRepo.removeSpaceMemberById(
            membership.id,
            membership.spaceId,
          );

          this.logger.debug({
            message: 'Removed space membership not present in Keycloak roles',
            userId: userId,
            spaceId: membership.spaceId,
            spaceSlug: spaceSlug,
            membershipId: membership.id,
          });
        }
      }
    } catch (error) {
      this.logger.warn({
        message: 'Failed to sync user space roles',
        userId: userId,
        workspaceId: workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
