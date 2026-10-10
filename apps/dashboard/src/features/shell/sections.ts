import type { LucideIcon } from 'lucide-react'
import {
  FileKey2,
  KeyRound,
  LogIn,
  Mail,
  MessageCircleQuestionMark,
  MessageSquareText,
  ScrollText,
  Settings,
  ShieldCheck,
  Smartphone,
  Timer,
  Users,
  Webhook,
} from 'lucide-react'

/** The base path of everything that belongs to one environment. */
export const ENVIRONMENT_PATH = '/w/$workspaceId/p/$projectId/e/$environmentId'

/** One screen of an environment, as the navigation lists it. */
export interface EnvironmentSection {
  /** The path segment after the environment id. */
  segment: string
  to:
    | '/w/$workspaceId/p/$projectId/e/$environmentId/users'
    | '/w/$workspaceId/p/$projectId/e/$environmentId/sign-in-methods'
    | '/w/$workspaceId/p/$projectId/e/$environmentId/password-policy'
    | '/w/$workspaceId/p/$projectId/e/$environmentId/sessions'
    | '/w/$workspaceId/p/$projectId/e/$environmentId/messages'
    | '/w/$workspaceId/p/$projectId/e/$environmentId/text-messages'
    | '/w/$workspaceId/p/$projectId/e/$environmentId/api-keys'
    | '/w/$workspaceId/p/$projectId/e/$environmentId/signing-keys'
    | '/w/$workspaceId/p/$projectId/e/$environmentId/webhooks'
    | '/w/$workspaceId/p/$projectId/e/$environmentId/hooks'
    | '/w/$workspaceId/p/$projectId/e/$environmentId/native-apps'
    | '/w/$workspaceId/p/$projectId/e/$environmentId/audit-log'
    | '/w/$workspaceId/p/$projectId/e/$environmentId/settings'
  label: string
  icon: LucideIcon
}

/** The screens of an environment, in navigation order. */
export const ENVIRONMENT_SECTIONS: readonly EnvironmentSection[] = [
  { segment: 'users', to: `${ENVIRONMENT_PATH}/users`, label: 'Users', icon: Users },
  {
    segment: 'sign-in-methods',
    to: `${ENVIRONMENT_PATH}/sign-in-methods`,
    label: 'Sign-in methods',
    icon: LogIn,
  },
  {
    segment: 'password-policy',
    to: `${ENVIRONMENT_PATH}/password-policy`,
    label: 'Password policy',
    icon: ShieldCheck,
  },
  {
    segment: 'sessions',
    to: `${ENVIRONMENT_PATH}/sessions`,
    label: 'Session profiles',
    icon: Timer,
  },
  { segment: 'messages', to: `${ENVIRONMENT_PATH}/messages`, label: 'Messages', icon: Mail },
  {
    segment: 'text-messages',
    to: `${ENVIRONMENT_PATH}/text-messages`,
    label: 'Text messages',
    icon: MessageSquareText,
  },
  { segment: 'api-keys', to: `${ENVIRONMENT_PATH}/api-keys`, label: 'API keys', icon: KeyRound },
  {
    segment: 'signing-keys',
    to: `${ENVIRONMENT_PATH}/signing-keys`,
    label: 'Signing keys',
    icon: FileKey2,
  },
  { segment: 'webhooks', to: `${ENVIRONMENT_PATH}/webhooks`, label: 'Webhooks', icon: Webhook },
  {
    segment: 'hooks',
    to: `${ENVIRONMENT_PATH}/hooks`,
    label: 'Hooks',
    icon: MessageCircleQuestionMark,
  },
  {
    segment: 'native-apps',
    to: `${ENVIRONMENT_PATH}/native-apps`,
    label: 'Native apps',
    icon: Smartphone,
  },
  {
    segment: 'audit-log',
    to: `${ENVIRONMENT_PATH}/audit-log`,
    label: 'Audit log',
    icon: ScrollText,
  },
  { segment: 'settings', to: `${ENVIRONMENT_PATH}/settings`, label: 'Settings', icon: Settings },
]

/**
 * The environment screen an address is on, so that switching environment keeps the screen.
 *
 * @param pathname - The router's current path.
 * @returns The matching section; the first (users) for any other path.
 */
export function sectionOf(pathname: string): EnvironmentSection {
  const segment = /\/e\/[^/]+\/([^/]+)/.exec(pathname)?.[1]
  const first = ENVIRONMENT_SECTIONS[0] as EnvironmentSection
  return ENVIRONMENT_SECTIONS.find((section) => section.segment === segment) ?? first
}
