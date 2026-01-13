export type AuthResponse = {
  access_token: string;
  expires_in: number;
  refresh_expires_in: number;
  refresh_token: string;
  token_type: string;
  scope: string;
  keycloakUser?: KeycloakAuthUser;
  user?: AuthUser;
};

export type KeycloakAuthUser = {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  roles: string[];
};

export type AuthUser = {
  id: string;
  email: string;
  isSuperAdmin: boolean;
  roles?: any;
};

export type KeyCloakUserInfo = {
  sub: string;
  preferred_username: string;
  email: string;
  given_name: string;
  family_name: string;
  realm_access?: {
    roles: Array<string>;
  };
};