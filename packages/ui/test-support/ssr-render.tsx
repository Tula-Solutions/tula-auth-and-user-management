import { TulaProvider } from '@tula-tech/react'
import { renderToString } from 'react-dom/server'
import { SignIn } from '@/components/tula/sign-in'
import { FormAlert, Status } from '@/components/tula/status'
import { StepCard } from '@/components/tula/step-card'

// Run by `src/server-render.test.ts` in a process of its own, with plain `bun run`: no test
// preload, so no DOM. It renders every item the way a server does and prints the HTML. An item
// that touched `window` or `document` while rendering would throw here.
if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
  throw new Error('ssr-render: expected no DOM globals')
}

const html = renderToString(
  <TulaProvider
    publishableKey='tula_pk_dev_unit00000000000000000000000000'
    baseUrl='https://auth.test'
  >
    <StepCard title='Step title' description='Step description' footer={<span>step footer</span>}>
      <p>step body</p>
    </StepCard>
    <StepCard title='Second level' level={2} focusTitle>
      <p>focused body</p>
    </StepCard>
    <Status message='status text' />
    <Status message='status done' tone='neutral' />
    <FormAlert message='alert text' detail='alert detail' />
    <SignIn onSwitchToSignUp={() => undefined} onForgotPassword={() => undefined} />
  </TulaProvider>
)
process.stdout.write(html)
