import { UserRole } from '../../generated/prisma/client.js';

export interface Actor {
  id: string;
  role: UserRole;
}

const VALID_ROLES = new Set<string>(Object.values(UserRole));

export function toActor(user: {
  id: string;
  role?: string | string[] | null;
}): Actor {
  const raw = Array.isArray(user.role) ? user.role[0] : user.role;

  if (!raw || !VALID_ROLES.has(raw)) {
    // Fallback: самый безопасный дефолт
    return { id: user.id, role: UserRole.GUEST };
  }
  return { id: user.id, role: raw as UserRole };
}
