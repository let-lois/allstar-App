import type { TeamMember } from '../types'

/**
 * Words for the server's three derived states. The console never invents a
 * status: these map what api/src/onboarding.ts computes onto what an admin
 * reads, and nothing else.
 */
export const INVITATION_LABEL: Record<NonNullable<TeamMember['invitation']>, string> = {
  not_sent: 'Not sent',
  pending: 'Pending',
  accepted: 'Accepted',
  expired: 'Expired',
  revoked: 'Revoked',
}
export const ONBOARDING_LABEL: Record<NonNullable<TeamMember['onboarding']>, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  complete: 'Complete',
  required: 'Update required',
}
export const BADGE_LABEL: Record<NonNullable<TeamMember['badge']>, string> = {
  none: 'Not created',
  awaiting_confirmation: 'Awaiting confirmation',
  active: 'Active',
  expired: 'Expired',
}
