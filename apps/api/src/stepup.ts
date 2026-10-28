// Step-up confirmation for high-impact actions (role changes, account status, disbursement, configuration, approvals).
// A stolen or left-open session alone must not be enough: the person re-enters their own password.
import { HttpError, q, verifyPassword, audit } from './core.ts';
import { rateLimit } from './http.ts';
import type { AuthUser } from './policy.ts';

export function confirmPassword(user: AuthUser, supplied: unknown, ip?: string) {
  rateLimit(`stepup:${user.id}`, 10, 15 * 60_000);
  const row = q.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', user.id);
  const ok = typeof supplied === 'string' && supplied.length > 0 && supplied.length <= 128 && !!row && verifyPassword(supplied, row.password_hash);
  if (!ok) {
    audit(user.id, 'security.stepup_failed', 'user', user.id, null, ip);
    throw new HttpError(403, 'confirmation_failed', 'Re-enter your password to confirm this action.', { confirm_password: 'Your current password is required and must be correct.' });
  }
}
