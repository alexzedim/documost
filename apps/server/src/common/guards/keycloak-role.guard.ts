import { KeycloakRole, ParsedKeycloakRole } from '../../core/auth/dto/keycloak-payload';
import {
  KEYCLOAK_ROLE_SPLITTER,
  SPACE_ROLE_SPLITTER,
} from '../constants/keycloak.const';

/**
 * Validates if a string is a valid Keycloak role string format
 * Format: PREFIX__SPACE_NAME-ROLE
 * Example: biz-komm-ai__mySpace-admin
 *
 * @param roleString - The role string to validate
 * @param allowedPrefix - The allowed prefix string
 * @returns true if the role string has valid format and prefix
 */
export function isValidKeycloakRoleString(
  roleString: unknown,
  allowedPrefix: string,
): roleString is string {
  if (typeof roleString !== 'string' || !roleString) {
    return false;
  }

  // Check if role string contains the keycloak role splitter
  if (!roleString.includes(KEYCLOAK_ROLE_SPLITTER)) {
    return false;
  }

  // Split by keycloak role splitter
  const parts = roleString.split(KEYCLOAK_ROLE_SPLITTER);

  // Must have exactly 2 parts: prefix and suffix
  if (parts.length !== 2) {
    return false;
  }

  const [prefix, suffix] = parts;

  const isAllowedPrefix = allowedPrefix === prefix;

  if (!isAllowedPrefix) {
    return false;
  }

  // Check if suffix contains the space role splitter
  if (!suffix.includes(SPACE_ROLE_SPLITTER)) {
    return false;
  }

  // Split suffix by space role splitter
  const suffixParts = suffix.split(SPACE_ROLE_SPLITTER);

  // Must have at least 2 parts: space name and role
  // Note: space name can contain dashes, so we take the last part as role
  if (suffixParts.length < 2) {
    return false;
  }

  // Get the role (last part after the final dash)
  const role = suffixParts[suffixParts.length - 1];

  // Validate that the role is a valid KeycloakRole
  return Object.values(KeycloakRole).includes(role as KeycloakRole);
}

/**
 * Validates if an object is a valid ParsedKeycloakRole
 *
 * @param obj - The object to validate
 * @returns true if the object is a valid ParsedKeycloakRole
 */
export function isValidParsedKeycloakRole(obj: unknown): obj is ParsedKeycloakRole {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }

  const parsed = obj as Partial<ParsedKeycloakRole>;

  return (
    typeof parsed.space === 'string' &&
    parsed.space.length > 0 &&
    Object.values(KeycloakRole).includes(parsed.role as KeycloakRole)
  );
}
