import { create } from 'zustand'

/** Whether this browser has a dashboard session, as far as the app knows. */
export type SessionStatus = 'unknown' | 'signed_in' | 'signed_out'

interface SessionState {
  status: SessionStatus
  /** When the session ends (ISO time); the cookie itself is HttpOnly and never read. */
  expiresAt: string | null
  /** Record a session the API confirmed. */
  signedIn: (expiresAt: string) => void
  /** Record that there is no session (a 401, or a sign-out). */
  signedOut: () => void
}

/**
 * What the app knows about the dashboard session: a status and an expiry time, nothing else.
 * The credential is an HttpOnly cookie the page cannot read.
 */
export const useSession = create<SessionState>((set) => ({
  status: 'unknown',
  expiresAt: null,
  signedIn: (expiresAt) => set({ status: 'signed_in', expiresAt }),
  signedOut: () => set({ status: 'signed_out', expiresAt: null }),
}))
