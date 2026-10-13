import { describe, expect, test } from 'bun:test'
import { planProcess, WorkerNotSeparateError } from '~/process'

// What a process of the image does, decided from the command it was started with (its role)
// and the deployment's WEBHOOK_WORKER. Everything `server.ts` and `worker.ts` start comes
// from this one answer.
describe('planProcess', () => {
  test('an API instance of a deployment that delivers in the API does everything, as before', () => {
    expect(planProcess('api', 'api')).toEqual({
      role: 'api',
      serves: 'api',
      jobs: ['retention', 'webhook_delivery'],
      deliversWebhooks: true,
    })
  })

  test('an API instance of a deployment with a separate worker makes no delivery', () => {
    expect(planProcess('api', 'separate')).toEqual({
      role: 'api',
      serves: 'api',
      // Retention makes no request to anyone's address and stays where the API is.
      jobs: ['retention'],
      deliversWebhooks: false,
    })
  })

  test('a worker delivers and does nothing else: no API, no retention', () => {
    expect(planProcess('worker', 'separate')).toEqual({
      role: 'worker',
      serves: 'health',
      jobs: ['webhook_delivery'],
      deliversWebhooks: true,
    })
  })

  test('a worker is refused where the API instances deliver: the two would not be separate', () => {
    expect(() => planProcess('worker', 'api')).toThrow(WorkerNotSeparateError)
    expect(() => planProcess('worker', 'api')).toThrow(
      'WEBHOOK_WORKER is `api`: the API instances make the webhook deliveries, so a worker process would not separate anything. Set WEBHOOK_WORKER=separate on every container (the API instances and this worker), or do not start a worker.'
    )
  })

  test('in every deployment that starts, some process delivers and exactly one kind does', () => {
    const plans = [
      [planProcess('api', 'api')],
      [planProcess('api', 'separate'), planProcess('worker', 'separate')],
    ]
    for (const deployment of plans) {
      const delivering = deployment.filter((plan) => plan.jobs.includes('webhook_delivery'))
      expect(delivering).toHaveLength(1)
      // The job and the permission to make a request never disagree.
      for (const plan of deployment) {
        expect(plan.deliversWebhooks).toBe(plan.jobs.includes('webhook_delivery'))
      }
      // Retention runs in exactly one kind of process too.
      expect(deployment.filter((plan) => plan.jobs.includes('retention'))).toHaveLength(1)
    }
  })
})
