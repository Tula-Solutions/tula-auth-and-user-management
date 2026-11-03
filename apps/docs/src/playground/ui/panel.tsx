import { type ReactNode, useEffect, useId, useRef } from 'react'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { Slider } from '~/components/ui/slider'
import { Switch } from '~/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import {
  buttonContrast,
  type Density,
  type FontChoice,
  isHex,
  LOOK_PRESETS,
  matchingLook,
  type Panel,
  type PlaygroundConfig,
  type Screen,
  setMethod,
  setMfaPolicy,
  setOrganizations,
  setProvider,
} from '../config'
import { PROVIDER_NAMES, SANDBOX_PROVIDERS, type SandboxMfaPolicy } from '../sandbox'

/** Props of {@link ConfigPanel}. */
export interface ConfigPanelProps {
  config: PlaygroundConfig
  panels: readonly Panel[]
  onChange(next: PlaygroundConfig): void
}

function Group(props: { title: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <fieldset className='pg-group' aria-labelledby={id}>
      <legend id={id} className='pg-group-title'>
        {props.title}
      </legend>
      {props.hint ? <p className='pg-hint'>{props.hint}</p> : null}
      {props.children}
    </fieldset>
  )
}

function SwitchRow(props: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange(on: boolean): void
}) {
  const id = useId()
  return (
    <div className='pg-switch-row'>
      <Label htmlFor={id} className='pg-switch-label'>
        <span>{props.label}</span>
        {props.hint ? <small>{props.hint}</small> : null}
      </Label>
      <Switch
        id={id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
      />
    </div>
  )
}

function Segmented<T extends string>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange(value: T): void
}) {
  return (
    <ToggleGroup
      type='single'
      variant='outline'
      aria-label={props.label}
      value={props.value}
      onValueChange={(value) => {
        // Pressing the selected item again would clear a single choice: keep it.
        if (value) {
          props.onChange(value as T)
        }
      }}
      className='pg-segmented'
    >
      {props.options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} aria-label={option.label}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

const SCREENS: { value: Screen; label: string }[] = [
  { value: 'sign-in', label: 'Sign in' },
  { value: 'sign-up', label: 'Sign up' },
  { value: 'account', label: 'Account' },
]

const ORGANIZATION_SCREENS: { value: Screen; label: string }[] = [
  { value: 'organization-switcher', label: 'Switcher' },
  { value: 'create-organization', label: 'Create' },
  { value: 'organization-profile', label: 'Profile' },
]

const MFA: { value: SandboxMfaPolicy; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'optional', label: 'Optional' },
  { value: 'required', label: 'Required' },
]

const DENSITY: { value: Density; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'spacious', label: 'Spacious' },
]

const FONTS: { value: FontChoice; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Monospace' },
]

/**
 * A one-thumb slider whose thumb has an accessible name. The shadcn primitive (not ours to edit)
 * names a thumb only when there are several, so the name is put on it after it is drawn.
 */
function NamedSlider(props: {
  id: string
  label: string
  min: number
  max: number
  value: number
  onChange(value: number): void
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    host.current?.querySelector('[role="slider"]')?.setAttribute('aria-label', props.label)
  }, [props.label])
  return (
    <div ref={host}>
      <Slider
        id={props.id}
        min={props.min}
        max={props.max}
        step={1}
        value={[props.value]}
        onValueChange={([next]) => props.onChange(next ?? props.value)}
      />
    </div>
  )
}

function ColorField(props: { label: string; value: string; onChange(value: string): void }) {
  const id = useId()
  return (
    <div className='pg-color'>
      <Label htmlFor={id}>{props.label}</Label>
      <div className='pg-color-input'>
        <input
          id={id}
          type='color'
          value={props.value}
          onChange={(event) => isHex(event.target.value) && props.onChange(event.target.value)}
        />
        <code>{props.value.toLowerCase()}</code>
      </div>
    </div>
  )
}

/**
 * The controls: which screen, which methods and providers, the two-step policy and the look.
 * Each control changes the configuration object and nothing else, so the frame, the sandbox
 * and the copied code all follow the same value.
 *
 * @param props - The configuration, the groups to show and the change handler.
 * @returns The panel.
 */
export function ConfigPanel({ config, panels, onChange }: ConfigPanelProps) {
  const has = (panel: Panel) => panels.includes(panel)
  const { settings } = config
  const look = matchingLook(config)
  const contrast = buttonContrast(config)
  const nameId = useId()
  const radiusId = useId()
  const fontId = useId()
  return (
    <div className='pg-panel'>
      {has('screen') ? (
        <Group title='Screen'>
          <Segmented
            label='Screen'
            value={config.screen}
            options={has('organizations') ? ORGANIZATION_SCREENS : SCREENS}
            onChange={(screen) => onChange({ ...config, screen })}
          />
          <p className='pg-hint'>
            {has('organizations') ? (
              'The switcher opens the other two from its Manage and Create buttons.'
            ) : (
              <>
                Reset a password from <strong>Forgot password</strong> on the sign-in screen.
              </>
            )}
          </p>
        </Group>
      ) : null}

      {has('methods') ? (
        <Group title='Ways to sign in'>
          <SwitchRow
            label='Password'
            checked={settings.methods.password}
            onChange={(on) => onChange(setMethod(config, 'password', on))}
          />
          <SwitchRow
            label='Emailed code'
            checked={settings.methods.emailCode}
            onChange={(on) => onChange(setMethod(config, 'emailCode', on))}
          />
          <SwitchRow
            label='Emailed link'
            hint='Also switches on the emailed code'
            checked={settings.methods.emailLink}
            onChange={(on) => onChange(setMethod(config, 'emailLink', on))}
          />
          <SwitchRow
            label='Passkey'
            hint='A simulated authenticator'
            checked={settings.methods.passkey}
            onChange={(on) => onChange(setMethod(config, 'passkey', on))}
          />
          <SwitchRow
            label='Sign up without a password'
            hint='Needs the emailed code'
            checked={settings.signUpPassword === 'optional'}
            disabled={!settings.methods.emailCode}
            onChange={(on) =>
              onChange({
                ...config,
                settings: { ...settings, signUpPassword: on ? 'optional' : 'required' },
              })
            }
          />
        </Group>
      ) : null}

      {has('providers') ? (
        <Group
          title='Continue with'
          hint='Each opens a sandbox consent screen, not the real provider.'
        >
          <ToggleGroup
            type='multiple'
            variant='outline'
            aria-label='OAuth providers'
            value={settings.oauth}
            onValueChange={(next) => {
              const chosen = new Set(next)
              let updated = config
              for (const provider of SANDBOX_PROVIDERS) {
                if (chosen.has(provider) !== settings.oauth.includes(provider)) {
                  updated = setProvider(updated, provider, chosen.has(provider))
                }
              }
              onChange(updated)
            }}
            className='pg-chips'
            spacing={1}
          >
            {SANDBOX_PROVIDERS.map((provider) => (
              <ToggleGroupItem key={provider} value={provider}>
                {PROVIDER_NAMES[provider]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Group>
      ) : null}

      {has('mfa') ? (
        <Group
          title='Two-step verification'
          hint='Try grace@example.test, who already has an authenticator app.'
        >
          <Segmented
            label='Two-step verification policy'
            value={settings.mfaPolicy}
            options={MFA}
            onChange={(policy) => onChange(setMfaPolicy(config, policy))}
          />
        </Group>
      ) : null}

      {has('organizations') ? (
        <Group
          title='Organizations'
          hint='Sign in as ada@example.test: she belongs to Acme as an admin and to Globex as a member.'
        >
          <SwitchRow
            label='Organizations'
            hint='Switching them off hides every organization component'
            checked={settings.organizations}
            onChange={(on) => onChange(setOrganizations(config, on))}
          />
        </Group>
      ) : null}

      {has('look') ? (
        <Group title='Look'>
          <div className='pg-field'>
            <Label htmlFor={nameId}>App name</Label>
            <Input
              id={nameId}
              value={settings.appName}
              maxLength={40}
              onChange={(event) =>
                onChange({
                  ...config,
                  settings: { ...settings, appName: event.target.value || 'Acme' },
                })
              }
            />
          </div>
          <Segmented
            label='Preset'
            value={(look ?? '') as string}
            options={LOOK_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
            onChange={(id) => {
              const preset = LOOK_PRESETS.find((one) => one.id === id)
              if (preset) {
                onChange({ ...config, ...preset.look })
              }
            }}
          />
          <div className='pg-colors'>
            <ColorField
              label='Brand colour'
              value={config.primary}
              onChange={(primary) => onChange({ ...config, primary })}
            />
            <ColorField
              label='Link colour'
              value={config.accent}
              onChange={(accent) => onChange({ ...config, accent })}
            />
          </div>
          {contrast < 4.5 ? (
            <p className='pg-warn' role='status'>
              The button text on this brand colour has a contrast of {contrast.toFixed(1)}:1. Aim
              for 4.5:1.
            </p>
          ) : null}
          <div className='pg-field'>
            <Label htmlFor={radiusId}>
              Corner radius <span className='pg-value'>{config.radius}px</span>
            </Label>
            <NamedSlider
              id={radiusId}
              label='Corner radius'
              min={0}
              max={24}
              value={config.radius}
              onChange={(radius) => onChange({ ...config, radius })}
            />
          </div>
          <div className='pg-field'>
            <Label htmlFor={fontId}>Typeface</Label>
            <Select
              value={config.font}
              onValueChange={(font) => onChange({ ...config, font: font as FontChoice })}
            >
              <SelectTrigger id={fontId} className='pg-select'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONTS.map((font) => (
                  <SelectItem key={font.value} value={font.value}>
                    {font.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Segmented
            label='Density'
            value={config.density}
            options={DENSITY}
            onChange={(density) => onChange({ ...config, density })}
          />
          <SwitchRow
            label='Flat card'
            hint='No shadow'
            checked={config.flat}
            onChange={(flat) => onChange({ ...config, flat })}
          />
        </Group>
      ) : null}
    </div>
  )
}
