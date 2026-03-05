/**
 * Keycloak role string format: PREFIX__SPACE_NAME-ROLE
 * Example: biz-komm-ai__mySpace-admin
 */

/**
 * Splitter between prefix and space-role suffix
 * Example: biz-komm-ai__mySpace-admin -> ['biz-komm-ai', 'mySpace-admin']
 */
export const KEYCLOAK_ROLE_SPLITTER = '__';

/**
 * Splitter between space name and role within the suffix
 * Example: mySpace-admin -> ['mySpace', 'admin']
 */
export const SPACE_ROLE_SPLITTER = '-';
