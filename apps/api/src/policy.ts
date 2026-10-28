// Role and permission model. Authorization is enforced server-side in routes via these helpers; deny by default.
import { HttpError, forbidden, q } from './core.ts';

export const CATEGORIES = ['student', 'lecturer', 'alumni', 'external_entrepreneur', 'external_participant', 'partner', 'mentor_applicant'] as const;
export type Category = (typeof CATEGORIES)[number];

export const ROLES = [
  'student', 'lecturer', 'alumni', 'external_entrepreneur', 'external_participant', 'partner',
  'mentor', 'programme_coordinator', 'funding_officer', 'incubation_manager', 'support_officer', 'admin', 'super_admin',
] as const;
export type Role = (typeof ROLES)[number];

/** Roles that confer staff-level capabilities and may only be granted by an administrator. */
export const STAFF_ROLES: Role[] = ['programme_coordinator', 'funding_officer', 'incubation_manager', 'support_officer', 'admin', 'super_admin'];
export const PRIVILEGED_ROLES: Role[] = ['admin', 'super_admin'];

export const PERMISSIONS = {
  'verification.review': ['support_officer', 'admin', 'super_admin'],
  'user.manage': ['admin', 'super_admin'],
  'mentor.review': ['incubation_manager', 'admin', 'super_admin'],
  'programme.manage': ['programme_coordinator', 'admin', 'super_admin'],
  'workshop.manage': ['programme_coordinator', 'incubation_manager', 'admin', 'super_admin'],
  'funding.manage': ['funding_officer', 'admin', 'super_admin'],
  'funding.review': ['funding_officer', 'super_admin'],
  'funding.disburse': ['admin', 'super_admin'],
  'venture.review': ['incubation_manager', 'programme_coordinator', 'admin', 'super_admin'],
  'milestone.review': ['incubation_manager', 'programme_coordinator', 'admin', 'super_admin'],
  'resource.create': ['lecturer', 'mentor', 'programme_coordinator', 'incubation_manager', 'admin', 'super_admin'],
  'resource.publish': ['programme_coordinator', 'incubation_manager', 'admin', 'super_admin'],
  'report.view': ['programme_coordinator', 'incubation_manager', 'funding_officer', 'partner', 'admin', 'super_admin'],
  'report.export': ['programme_coordinator', 'incubation_manager', 'admin', 'super_admin'],
  'audit.view': ['admin', 'super_admin'],
  'support.manage': ['support_officer', 'admin', 'super_admin'],
  'config.manage': ['super_admin'],
  'portal.admin': ['programme_coordinator', 'funding_officer', 'incubation_manager', 'support_officer', 'admin', 'super_admin'],
  'governance.manage': ['admin', 'super_admin'],
  'governance.approve': ['super_admin'],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export type AuthUser = {
  id: string;
  email: string;
  full_name: string;
  category: string;
  account_status: string;
  email_verified: number;
  verification_status: string;
  roles: Role[];
};

export const hasRole = (u: AuthUser, ...roles: Role[]) => u.roles.some((r) => roles.includes(r));
export const can = (u: AuthUser, p: Permission) => u.roles.some((r) => (PERMISSIONS[p] as readonly Role[]).includes(r));
export function require_(u: AuthUser, p: Permission) {
  if (!can(u, p)) throw forbidden();
}
export const isStaff = (u: AuthUser) => u.roles.some((r) => STAFF_ROLES.includes(r));

/** A person may take part in institutional workflows only if the account is active, email-confirmed and verified. */
export function requireVerified(u: AuthUser) {
  if (u.account_status !== 'active') throw forbidden('This account is not active.');
  if (!u.email_verified) throw new HttpError(403, 'email_unverified', 'Confirm your email address first.');
  if (u.verification_status !== 'verified') throw new HttpError(403, 'not_verified', 'Complete verification before using this feature.');
}

export const isVentureMember = (venture: string, user: string) =>
  !!q.get('SELECT 1 FROM venture_members WHERE venture_id = ? AND user_id = ?', venture, user);

/** The category-specific role granted when verification is approved. */
export const categoryRole = (c: string): Role | null =>
  (['student', 'lecturer', 'alumni', 'external_entrepreneur', 'external_participant', 'partner'] as string[]).includes(c) ? (c as Role) : null;

/** Evidence required for each registration category. */
export const REQUIRED_DOCUMENT: Record<string, string> = {
  student: 'student_id',
  lecturer: 'staff_id',
  alumni: 'alumni_evidence',
  external_entrepreneur: 'identity_document',
  external_participant: 'identity_document',
  partner: 'organization_evidence',
  mentor_applicant: 'identity_document',
};
export const DOCUMENT_CATEGORIES = [
  'student_id', 'staff_id', 'enrollment_evidence', 'alumni_evidence', 'identity_document', 'organization_evidence',
  'professional_certificate', 'mentor_credential', 'reference', 'business_registration', 'venture_document',
  'funding_attachment', 'milestone_evidence', 'resource_file',
] as const;
