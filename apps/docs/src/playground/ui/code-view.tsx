import { useRef, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { configTs, cssBlock, jsx } from '../code'
import type { PlaygroundConfig } from '../config'

/**
 * Copy text to the clipboard, falling back to selecting it where the page may not write to it.
 *
 * @param text - What to copy.
 * @returns Whether it was copied.
 */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * A button that copies text and says so.
 *
 * @param props - The text and the button's label.
 * @returns The button, with a live region for the result.
 */
export function CopyButton(props: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  return (
    <>
      <button
        type='button'
        className='pg-copy'
        onClick={async () => {
          setState((await copy(props.text)) ? 'copied' : 'failed')
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setState('idle'), 1800)
        }}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Press Ctrl/Cmd+C' : props.label}
      </button>
      <span className='pg-sr' role='status'>
        {state === 'copied' ? 'Copied to the clipboard' : ''}
      </span>
    </>
  )
}

const FILES = [
  { id: 'react', label: 'React', name: 'page.tsx' },
  { id: 'css', label: 'CSS', name: 'tula.css' },
  { id: 'config', label: 'Config', name: 'tula.config.ts' },
] as const

/**
 * The code for what the frame shows: the component, the stylesheet of changed tokens and the
 * environment's config file. All three are written from the configuration, on every change.
 *
 * @param props - The configuration.
 * @returns Tabs of code, each with a copy button.
 */
export function CodeView({ config }: { config: PlaygroundConfig }) {
  const texts = { react: jsx(config), css: cssBlock(config), config: configTs(config) }
  return (
    <Tabs defaultValue='react' className='pg-code'>
      <div className='pg-code-bar'>
        <TabsList aria-label='Code to copy'>
          {FILES.map((file) => (
            <TabsTrigger key={file.id} value={file.id} className='text-muted-foreground'>
              {file.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {FILES.map((file) => (
        <TabsContent key={file.id} value={file.id}>
          <div className='pg-codebox'>
            <div className='pg-codebox-head'>
              <span>{file.name}</span>
              <CopyButton text={texts[file.id]} label='Copy' />
            </div>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable code box must be reachable by keyboard */}
            <pre tabIndex={0} data-code={file.id}>
              <code>{texts[file.id]}</code>
            </pre>
          </div>
        </TabsContent>
      ))}
    </Tabs>
  )
}
