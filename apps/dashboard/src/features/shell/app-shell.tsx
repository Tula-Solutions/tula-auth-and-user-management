import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { Activity, LogOut, Menu, Plus, ScrollText, Stethoscope } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import {
  useDeleteDashboardSession,
  useListInstanceEnvironments,
  useListProjects,
  useListWorkspaces,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { EnvironmentBadge, type EnvironmentKind, KIND_LABEL } from '~/components/environment-badge'
import { Modal } from '~/components/modal'
import { type NavigationFocus, NavigationFocusContext } from '~/components/page'
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select'
import { cn } from '~/lib/utils'
import { useScope } from '~/state/scope'
import { useSession } from '~/state/session'
import { AddEnvironmentDialog, CreateProjectDialog, CreateWorkspaceDialog } from './create-dialogs'
import { ENVIRONMENT_SECTIONS, sectionOf } from './sections'

/** Every list the switcher draws fits one page of this size. */
const SWITCHER_PAGE = { page: 1, size: 100 }
const KINDS: readonly EnvironmentKind[] = ['development', 'production']

const navLink =
  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-sidebar-ring data-[status=active]:bg-sidebar-accent data-[status=active]:text-sidebar-foreground'
const navHeading =
  'px-3 pt-4 pb-1 text-xs font-semibold tracking-wider text-sidebar-muted uppercase'

/**
 * The navigation: the workspace, its projects, the selected environment's screens and the
 * instance's own. Drawn in the sidebar, and in a dialog on a narrow screen.
 */
function Navigation({ onSignOut, signingOut }: { onSignOut: () => void; signingOut: boolean }) {
  const { workspaceId, projectId, environmentId } = useScope()
  const navigate = useNavigate()
  const switcherId = useId()
  const [dialog, setDialog] = useState<'workspace' | 'project' | null>(null)
  const workspaces = useListWorkspaces(SWITCHER_PAGE)
  const projects = useListProjects(
    { workspaceId: workspaceId ?? '', ...SWITCHER_PAGE },
    { query: { enabled: workspaceId !== null } }
  )

  return (
    <div className='flex h-full flex-col gap-1 p-3 text-sidebar-foreground'>
      <div className='flex flex-col gap-2 rounded-lg bg-sidebar-accent p-3 [&>[data-slot=native-select-wrapper]]:w-full'>
        <label htmlFor={switcherId} className='text-xs font-semibold text-sidebar-muted'>
          Workspace
        </label>
        <NativeSelect
          id={switcherId}
          className='w-full border-sidebar-border bg-sidebar text-sidebar-foreground'
          value={workspaceId ?? ''}
          onChange={(event) => {
            if (event.target.value !== '') {
              void navigate({ to: '/w/$workspaceId', params: { workspaceId: event.target.value } })
            }
          }}
        >
          {workspaceId === null ? (
            <NativeSelectOption value=''>Choose a workspace</NativeSelectOption>
          ) : null}
          {(workspaces.data?.data ?? []).map((workspace) => (
            <NativeSelectOption key={workspace.id} value={workspace.id}>
              {workspace.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <button
          type='button'
          className={cn(navLink, 'px-1 py-1')}
          onClick={() => setDialog('workspace')}
        >
          <Plus aria-hidden='true' className='size-4' />
          New workspace
        </button>
      </div>

      <nav aria-label='Projects' className='flex flex-col gap-0.5'>
        <h2 className={navHeading}>Projects</h2>
        {workspaceId !== null
          ? (projects.data?.data ?? []).map((project) => (
              <Link
                key={project.id}
                to='/w/$workspaceId/p/$projectId'
                params={{ workspaceId, projectId: project.id }}
                className={navLink}
              >
                <span className='truncate'>{project.name}</span>
              </Link>
            ))
          : null}
        {workspaceId !== null && projects.data?.data.length === 0 ? (
          <p className='px-3 py-1 text-sm text-sidebar-muted'>No projects yet.</p>
        ) : null}
        {workspaceId !== null ? (
          <button type='button' className={navLink} onClick={() => setDialog('project')}>
            <Plus aria-hidden='true' className='size-4' />
            Create project
          </button>
        ) : null}
      </nav>

      {workspaceId !== null && projectId !== null && environmentId !== null ? (
        <nav aria-label='Environment' className='flex flex-col gap-0.5'>
          <h2 className={navHeading}>Environment</h2>
          {ENVIRONMENT_SECTIONS.map((section) => (
            <Link
              key={section.segment}
              to={section.to}
              params={{ workspaceId, projectId, environmentId }}
              className={navLink}
              activeProps={{ 'aria-current': 'page' }}
            >
              <section.icon aria-hidden='true' className='size-4' />
              {section.label}
            </Link>
          ))}
        </nav>
      ) : null}

      <nav aria-label='Instance' className='flex flex-col gap-0.5'>
        <h2 className={navHeading}>Instance</h2>
        <Link to='/instance/audit-log' className={navLink} activeProps={{ 'aria-current': 'page' }}>
          <ScrollText aria-hidden='true' className='size-4' />
          Instance audit log
        </Link>
        <Link
          to='/instance/diagnostics'
          className={navLink}
          activeProps={{ 'aria-current': 'page' }}
        >
          <Stethoscope aria-hidden='true' className='size-4' />
          Diagnostics
        </Link>
      </nav>

      <div className='mt-auto pt-4'>
        <button
          type='button'
          className={cn(navLink, 'w-full')}
          onClick={onSignOut}
          aria-busy={signingOut || undefined}
        >
          <LogOut aria-hidden='true' className='size-4' />
          Sign out
        </button>
      </div>

      <CreateWorkspaceDialog
        open={dialog === 'workspace'}
        onClose={() => setDialog(null)}
        onCreated={(workspace) =>
          void navigate({ to: '/w/$workspaceId', params: { workspaceId: workspace.id } })
        }
      />
      {workspaceId !== null ? (
        <CreateProjectDialog
          workspaceId={workspaceId}
          open={dialog === 'project'}
          onClose={() => setDialog(null)}
          onCreated={({ project }) =>
            void navigate({
              to: '/w/$workspaceId/p/$projectId',
              params: { workspaceId, projectId: project.id },
            })
          }
        />
      ) : null}
    </div>
  )
}

/**
 * The top of the page: where the operator is, and the environment switcher
 * (Design.pdf page 6: a segmented control, top right).
 */
function ScopeBar({ pathname }: { pathname: string }) {
  const { workspaceId, projectId, environmentId } = useScope()
  const navigate = useNavigate()
  const [adding, setAdding] = useState<EnvironmentKind | null>(null)
  const workspaces = useListWorkspaces(SWITCHER_PAGE)
  const projects = useListProjects(
    { workspaceId: workspaceId ?? '', ...SWITCHER_PAGE },
    { query: { enabled: workspaceId !== null } }
  )
  const environments = useListInstanceEnvironments(
    { projectId: projectId ?? '', ...SWITCHER_PAGE },
    { query: { enabled: projectId !== null } }
  )
  const workspace = workspaces.data?.data.find((entry) => entry.id === workspaceId)
  const project = projects.data?.data.find((entry) => entry.id === projectId)
  const current = environments.data?.data.find((entry) => entry.id === environmentId)
  const section = sectionOf(pathname)

  if (workspaceId === null) {
    return null
  }
  return (
    <div className='flex flex-wrap items-center justify-between gap-3'>
      <nav aria-label='Breadcrumb' className='min-w-0 text-sm text-muted-foreground'>
        <ol className='flex flex-wrap items-center gap-1.5'>
          <li>
            <Link
              to='/w/$workspaceId'
              params={{ workspaceId }}
              className='text-link underline underline-offset-4'
            >
              {workspace?.name ?? 'Workspace'}
            </Link>
          </li>
          {projectId !== null ? (
            <li className='flex items-center gap-1.5'>
              <span aria-hidden='true'>/</span>
              <span className='font-medium text-foreground'>{project?.name ?? 'Project'}</span>
            </li>
          ) : null}
        </ol>
      </nav>
      {projectId !== null && environments.data ? (
        <div className='flex flex-wrap items-center gap-2'>
          {current ? <EnvironmentBadge kind={current.kind} /> : null}
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would need a legend drawn; this is a labelled group of links. */}
          <div
            role='group'
            aria-label='Switch environment'
            className='inline-flex rounded-lg border bg-muted p-1'
          >
            {KINDS.map((kind) => {
              const environment = environments.data.data.find((entry) => entry.kind === kind)
              if (!environment) {
                return (
                  <button
                    key={kind}
                    type='button'
                    className='inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground'
                    onClick={() => setAdding(kind)}
                  >
                    <Plus aria-hidden='true' className='size-3.5' />
                    Add {KIND_LABEL[kind].toLowerCase()}
                  </button>
                )
              }
              const selected = environment.id === environmentId
              return (
                <Link
                  key={kind}
                  to={section.to}
                  params={{ workspaceId, projectId, environmentId: environment.id }}
                  aria-current={selected ? 'true' : undefined}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium',
                    selected
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {KIND_LABEL[kind]}
                </Link>
              )
            })}
          </div>
          {adding !== null ? (
            <AddEnvironmentDialog
              projectId={projectId}
              kind={adding}
              open
              onClose={() => setAdding(null)}
              onCreated={(id) =>
                void navigate({
                  to: section.to,
                  params: { workspaceId, projectId, environmentId: id },
                })
              }
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The frame around every signed-in screen: the dark navigation on the left, the scope bar
 * and the screen on the right (Design.pdf page 6). Under the `md` breakpoint the navigation
 * moves into a dialog opened from a top bar.
 *
 * It also watches the session: when a call is answered `auth.unauthenticated`, the app
 * returns to sign-in and comes back to the same address afterwards.
 *
 * @param props - `children`: the screen.
 * @returns The shell.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const location = useRouterState({ select: (state) => state.location })
  const status = useSession((state) => state.status)
  const signedOut = useSession((state) => state.signedOut)
  const signOut = useDeleteDashboardSession()
  const [menuOpen, setMenuOpen] = useState(false)
  const resolvedPath = useRouterState({ select: (state) => state.resolvedLocation?.pathname })
  const lastPath = useRef(location.pathname)
  const [focus, setFocus] = useState<NavigationFocus>(() => ({ token: 0, handled: { current: 0 } }))
  const leaving = useRef(false)
  const returned = useRef(false)

  useEffect(() => {
    if (status !== 'signed_out') {
      returned.current = false
      return
    }
    // Once per ended session: the navigation below changes the address, which would run
    // this effect again and replace the destination with the sign-in page itself.
    if (returned.current) {
      return
    }
    returned.current = true
    // Nothing fetched under the ended session may be drawn for whoever signs in next.
    queryClient.clear()
    void navigate({
      to: '/sign-in',
      search: leaving.current ? {} : { redirect: location.href },
      replace: true,
    })
  }, [status, navigate, queryClient, location.href])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the address is the trigger; following a link in the menu closes it.
  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  // Counted on the *resolved* address: by then the new screen is on the page. Counting on
  // the requested address would hand the focus to the heading of the screen being left.
  useEffect(() => {
    if (resolvedPath !== undefined && lastPath.current !== resolvedPath) {
      lastPath.current = resolvedPath
      setFocus((current) => ({ ...current, token: current.token + 1 }))
    }
  }, [resolvedPath])

  function handleSignOut() {
    leaving.current = true
    // Signed out here whatever the API answers: a failed request must not leave the
    // operator looking signed in.
    signOut.mutate(undefined, { onSettled: () => signedOut() })
  }

  const navigation = <Navigation onSignOut={handleSignOut} signingOut={signOut.isPending} />
  return (
    <div className='flex min-h-dvh flex-col md:flex-row'>
      <a
        href='#main'
        className='sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2'
      >
        Skip to content
      </a>
      <aside className='hidden w-64 shrink-0 bg-sidebar md:block'>
        <div className='sticky top-0 h-dvh overflow-y-auto'>{navigation}</div>
      </aside>
      <header className='flex items-center justify-between gap-3 bg-sidebar px-4 py-3 text-sidebar-foreground md:hidden'>
        <span className='flex items-center gap-2 font-semibold'>
          <Activity aria-hidden='true' className='size-4' />
          Tula dashboard
        </span>
        <ActionButton
          variant='outline'
          size='sm'
          className='border-sidebar-border bg-sidebar text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
          onClick={() => setMenuOpen(true)}
        >
          <Menu aria-hidden='true' />
          Menu
        </ActionButton>
      </header>
      <Modal
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title='Menu'
        className='bg-sidebar text-sidebar-foreground md:hidden'
        footer={
          <ActionButton variant='secondary' onClick={() => setMenuOpen(false)}>
            Close
          </ActionButton>
        }
      >
        {navigation}
      </Modal>
      <main
        id='main'
        tabIndex={-1}
        className='flex min-w-0 flex-1 flex-col gap-6 p-4 outline-none sm:p-6 lg:p-10'
      >
        <ScopeBar pathname={location.pathname} />
        <NavigationFocusContext.Provider value={focus}>{children}</NavigationFocusContext.Provider>
      </main>
    </div>
  )
}
