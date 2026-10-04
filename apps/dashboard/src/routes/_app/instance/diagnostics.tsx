import { createFileRoute } from '@tanstack/react-router'
import { DiagnosticsScreen } from '~/features/diagnostics/diagnostics-screen'

export const Route = createFileRoute('/_app/instance/diagnostics')({
  component: DiagnosticsScreen,
})
