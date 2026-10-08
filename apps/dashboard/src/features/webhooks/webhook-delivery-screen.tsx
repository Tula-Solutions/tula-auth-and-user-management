import { PageHeader } from '~/components/page'
import type { EnvironmentScope } from '~/features/users/users-screen'

/** Props of {@link WebhookDeliveryScreen}. */
export interface WebhookDeliveryScreenProps {
  scope: EnvironmentScope
  endpointId: string
  deliveryId: string
}

/**
 * One delivery and every request the server made for it.
 *
 * @param _props - See {@link WebhookDeliveryScreenProps}.
 * @returns The screen.
 */
export function WebhookDeliveryScreen(_props: WebhookDeliveryScreenProps) {
  return <PageHeader title='Delivery' />
}
