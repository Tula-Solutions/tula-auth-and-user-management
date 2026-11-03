import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { EMBED_PRESETS, type PlaygroundConfig } from '../config'
import {
  attemptOfAuthorizationUrl,
  createSandbox,
  type PasskeySheetRequest,
  pendingOAuth,
  type Sandbox,
} from '../sandbox'
import { CodeView } from './code-view'
import { toggleSiteScheme, useSiteScheme, useWorld } from './hooks'
import { ConfigPanel } from './panel'
import { addressOf, Stage, type View } from './stage'
import { Accounts, Inbox } from './tools'

interface Sheet {
  request: PasskeySheetRequest
  answer(approved: boolean): void
}

/** The simulated passkey sheet. It says it is simulated: the real one belongs to the device. */
function PasskeySheet({ sheet }: { sheet: Sheet }) {
  const ok = useRef<HTMLButtonElement>(null)
  useEffect(() => ok.current?.focus(), [])
  const creating = sheet.request.kind === 'create'
  return (
    <div className='pg-sheet-wrap'>
      <div className='pg-sheet' role='dialog' aria-modal='false' aria-labelledby='pg-sheet-title'>
        <p className='pg-sheet-flag'>Simulated authenticator</p>
        <h3 id='pg-sheet-title'>{creating ? 'Save a passkey?' : 'Use your passkey?'}</h3>
        <p className='pg-muted'>
          {creating
            ? `Create a passkey for ${sheet.request.account ?? 'this account'} on ${sheet.request.rpName}.`
            : `Sign in to ${sheet.request.rpName} with the passkey this sandbox holds.`}{' '}
          This is not your device's prompt: the sandbox never calls your browser's passkey API.
        </p>
        <div className='pg-row'>
          <button
            ref={ok}
            type='button'
            className='pg-btn pg-btn-primary'
            onClick={() => sheet.answer(true)}
          >
            {creating ? 'Save passkey' : 'Continue'}
          </button>
          <button type='button' className='pg-btn' onClick={() => sheet.answer(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

/** Props of {@link Playground}. */
export interface PlaygroundProps {
  /** The preset id from the page's `:::playground{preset="…"}`. */
  preset: string
}

/**
 * The playground: a sandbox service in this page, the real components talking to it, a panel
 * to configure both and the code for what is shown. One mounted island per placeholder.
 *
 * @param props - The preset to start from.
 * @returns The playground.
 */
export function Playground({ preset: presetId }: PlaygroundProps) {
  const preset = EMBED_PRESETS[presetId] ?? EMBED_PRESETS.full
  const [config, setConfig] = useState<PlaygroundConfig>(preset?.config as PlaygroundConfig)
  const [view, setView] = useState<View>({ kind: 'screen' })
  const [epoch, setEpoch] = useState(0)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [tool, setTool] = useState<'inbox' | 'accounts'>('inbox')
  const scheme = useSiteScheme()

  // The sandbox's callbacks outlive a render: they read the latest handlers through a ref.
  const latest = useRef<{
    navigateOut(url: string): void
    confirmPasskey(request: PasskeySheetRequest): Promise<boolean>
  }>({ navigateOut: () => {}, confirmPasskey: async () => false })

  const [instance, setInstance] = useState(0)
  // A reset builds a new sandbox with the settings as they are then; settings changes go
  // through `configure` below instead, so the accounts and the inbox are kept.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const sandbox: Sandbox = useMemo(
    () =>
      createSandbox({
        settings: config.settings,
        pageUrl: `${window.location.origin}/`,
        latencyMs: 220,
        onNavigate: (url) => latest.current.navigateOut(url),
        confirmPasskey: (request) => latest.current.confirmPasskey(request),
      }),
    [instance]
  )
  latest.current = {
    navigateOut(url) {
      const id = attemptOfAuthorizationUrl(url)
      const request = id ? pendingOAuth(sandbox.world, id) : null
      if (request) {
        setView({ kind: 'consent', request })
      }
    },
    confirmPasskey: (request) =>
      new Promise<boolean>((resolve) => {
        setSheet({
          request,
          answer: (approved) => {
            setSheet(null)
            resolve(approved)
          },
        })
      }),
  }

  const update = useCallback(
    (next: PlaygroundConfig) => {
      const settingsChanged = JSON.stringify(next.settings) !== JSON.stringify(config.settings)
      setConfig(next)
      if (settingsChanged) {
        sandbox.world.configure(next.settings)
        // The client caches the environment's config; ask again, then rebuild the screen.
        sandbox.client.config.get({ force: true }).then(
          () => setEpoch((count) => count + 1),
          () => setEpoch((count) => count + 1)
        )
      }
      if (next.screen !== config.screen) {
        setView({ kind: 'screen' })
      }
    },
    [config, sandbox]
  )

  const reset = () => {
    setView({ kind: 'screen' })
    setSheet(null)
    setInstance((count) => count + 1)
    setEpoch((count) => count + 1)
  }

  const open = (url: string, where: 'here' | 'other') => {
    sandbox.page.set(url)
    setView({ kind: 'email-link', where, url })
  }

  useWorld(sandbox.world)
  const mails = sandbox.world.inbox.length
  const panels = preset?.panels ?? []
  const [announce, setAnnounce] = useState('')
  const seen = useRef(0)
  useEffect(() => {
    if (mails > seen.current) {
      setAnnounce(`New email in the sandbox inbox (${mails})`)
    }
    seen.current = mails
  }, [mails])

  return (
    <section className='pg' aria-label='Component playground' data-ready=''>
      <div className='pg-main'>
        <div className='pg-stage-col'>
          <div className='pg-bar'>
            <span className='pg-sandbox' title='Nothing here calls a real service'>
              <span className='pg-dot' aria-hidden='true' />
              Sandbox
            </span>
            <span className='pg-bar-spacer' />
            <button type='button' className='pg-btn pg-btn-quiet' onClick={toggleSiteScheme}>
              {scheme === 'dark' ? 'Light' : 'Dark'} preview
            </button>
            <button type='button' className='pg-btn pg-btn-quiet' onClick={reset}>
              Reset sandbox
            </button>
          </div>
          <div className='pg-stage' data-view={view.kind}>
            <div className='pg-url' aria-hidden='true'>
              <span className='pg-lock' />
              {addressOf(config, view)}
            </div>
            <div className='pg-frame'>
              <Stage
                sandbox={sandbox}
                config={config}
                scheme={scheme}
                view={view}
                epoch={epoch}
                go={setView}
                show={(screen) => update({ ...config, screen })}
              />
              {sheet ? <PasskeySheet sheet={sheet} /> : null}
            </div>
            {view.kind !== 'screen' ? (
              <button
                type='button'
                className='pg-btn pg-back'
                onClick={() => setView({ kind: 'screen' })}
              >
                Back to the app
              </button>
            ) : null}
          </div>
          <p className='pg-note'>
            The sandbox is a stand-in for the Tula API that runs in this page. No account, email or
            passkey here is real, and nothing is sent anywhere.
          </p>
          <Tabs value={tool} onValueChange={(value) => setTool(value as 'inbox' | 'accounts')}>
            <TabsList aria-label='Sandbox tools'>
              <TabsTrigger value='inbox' className='text-muted-foreground'>
                Inbox{mails ? ` (${mails})` : ''}
              </TabsTrigger>
              <TabsTrigger value='accounts' className='text-muted-foreground'>
                Accounts and codes
              </TabsTrigger>
            </TabsList>
            <TabsContent value='inbox'>
              <Inbox sandbox={sandbox} onOpen={open} />
            </TabsContent>
            <TabsContent value='accounts'>
              <Accounts sandbox={sandbox} />
            </TabsContent>
          </Tabs>
        </div>
        <div className='pg-panel-col'>
          <ConfigPanel config={config} panels={panels} onChange={update} />
        </div>
      </div>
      <CodeView config={config} />
      <p className='pg-sr' role='status'>
        {announce}
      </p>
      {preset?.tryIt.length ? (
        <div className='pg-try'>
          <h3>Try this</h3>
          <ul>
            {preset.tryIt.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
