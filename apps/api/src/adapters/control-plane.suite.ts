import { beforeEach, describe, expect, test } from 'bun:test'
import type {
  ControlPlane,
  InstanceActivity,
  ProjectRecord,
  WorkspaceRecord,
} from '~/ports/control-plane'
import type { EnvironmentRecord } from '~/ports/environment-repository'

/**
 * Behaviour every `ControlPlane` must have. Run against each adapter so the memory store used
 * by unit tests can't drift from Postgres.
 *
 * The Postgres database is shared between tests, so every test works on rows of its own and
 * filters by their ids.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds the store; called before each test.
 */
export function describeControlPlane(name: string, setup: () => Promise<ControlPlane>): void {
  describe(`${name} (ControlPlane)`, () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z')
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000)
    let plane: ControlPlane
    let actorId: string

    beforeEach(async () => {
      plane = await setup()
      actorId = Bun.randomUUIDv7()
    })

    function activity(
      type: InstanceActivity['type'],
      target: InstanceActivity['target'],
      overrides: Partial<InstanceActivity> = {}
    ): InstanceActivity {
      return {
        id: Bun.randomUUIDv7(),
        type,
        actor: { type: 'instance_admin', id: actorId },
        target,
        ipAddress: '203.0.113.9',
        userAgent: 'suite/1.0',
        data: {},
        occurredAt: t0,
        ...overrides,
      }
    }

    function workspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
      return { id: Bun.randomUUIDv7(), name: 'Acme', createdAt: t0, ...overrides }
    }

    function project(workspaceId: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
      return {
        id: Bun.randomUUIDv7(),
        workspaceId,
        name: 'Web app',
        createdAt: t0,
        updatedAt: t0,
        ...overrides,
      }
    }

    function environment(
      projectId: string,
      kind: EnvironmentRecord['kind'],
      createdAt = t0
    ): EnvironmentRecord {
      return { id: Bun.randomUUIDv7(), projectId, kind, createdAt }
    }

    async function seededWorkspace(): Promise<WorkspaceRecord> {
      const created = workspace()
      await plane.createWorkspace(
        created,
        activity('workspace.created', { type: 'workspace', id: created.id })
      )
      return created
    }

    async function actions(): Promise<string[]> {
      const { items } = await plane.listAudit({ actorId, page: 1, size: 50 })
      return items.map((entry) => entry.type)
    }

    test('a workspace is stored with its audit entry and can be found and listed', async () => {
      const created = await seededWorkspace()
      expect(await plane.findWorkspace(created.id)).toEqual(created)
      expect(await plane.findWorkspace(Bun.randomUUIDv7())).toBeNull()
      const { items, totalCount } = await plane.listWorkspaces({ page: 1, size: 100 })
      expect(items.map((item) => item.id)).toContain(created.id)
      expect(totalCount).toBeGreaterThanOrEqual(items.length)
      expect(await actions()).toEqual(['workspace.created'])
    })

    test('a project is stored with its environments and every audit entry', async () => {
      const owner = await seededWorkspace()
      const created = project(owner.id)
      const development = environment(created.id, 'development')
      const production = environment(created.id, 'production')
      await plane.createProject(
        created,
        // Stored production first: the list still answers development first.
        [production, development],
        [
          activity('project.created', { type: 'project', id: created.id }),
          activity('environment.created', { type: 'environment', id: development.id }),
          activity('environment.created', { type: 'environment', id: production.id }),
        ]
      )
      expect(await plane.findProject(created.id)).toEqual(created)
      expect(await plane.findProject(Bun.randomUUIDv7())).toBeNull()
      const listed = await plane.listEnvironments({ projectId: created.id, page: 1, size: 10 })
      expect(listed.items).toEqual([development, production])
      expect(listed.totalCount).toBe(2)
      expect((await actions()).sort()).toEqual([
        'environment.created',
        'environment.created',
        'project.created',
        'workspace.created',
      ])
    })

    test('projects are listed per workspace, oldest first, one page at a time', async () => {
      const owner = await seededWorkspace()
      const other = await seededWorkspace()
      const first = project(owner.id, { name: 'First', createdAt: at(1), updatedAt: at(1) })
      const second = project(owner.id, { name: 'Second', createdAt: at(2), updatedAt: at(2) })
      const foreign = project(other.id, { name: 'Foreign' })
      // Created out of order.
      for (const item of [second, foreign, first]) {
        await plane.createProject(
          item,
          [],
          [activity('project.created', { type: 'project', id: item.id })]
        )
      }
      const all = await plane.listProjects({ workspaceId: owner.id, page: 1, size: 10 })
      expect(all.items).toEqual([first, second])
      expect(all.totalCount).toBe(2)
      const pageTwo = await plane.listProjects({ workspaceId: owner.id, page: 2, size: 1 })
      expect(pageTwo.items).toEqual([second])
      expect(pageTwo.totalCount).toBe(2)
      const everything = await plane.listProjects({ page: 1, size: 100 })
      expect(everything.items.map((item) => item.id)).toContain(foreign.id)
    })

    test('renaming a project records it; an unknown project changes and records nothing', async () => {
      const owner = await seededWorkspace()
      const created = project(owner.id)
      await plane.createProject(
        created,
        [],
        [activity('project.created', { type: 'project', id: created.id })]
      )
      const renamed = await plane.renameProject(
        created.id,
        'Mobile app',
        at(5),
        activity('project.renamed', { type: 'project', id: created.id })
      )
      expect(renamed).toEqual({ ...created, name: 'Mobile app', updatedAt: at(5) })
      expect(await plane.findProject(created.id)).toEqual(renamed)

      const missing = Bun.randomUUIDv7()
      expect(
        await plane.renameProject(
          missing,
          'Nothing',
          at(6),
          activity('project.renamed', { type: 'project', id: missing })
        )
      ).toBeNull()
      expect((await actions()).filter((type) => type === 'project.renamed')).toHaveLength(1)
    })

    test('a project holds one environment of each kind: a second one is refused and not recorded', async () => {
      const owner = await seededWorkspace()
      const created = project(owner.id)
      await plane.createProject(
        created,
        [],
        [activity('project.created', { type: 'project', id: created.id })]
      )
      const development = environment(created.id, 'development')
      expect(
        await plane.createEnvironment(
          development,
          activity('environment.created', { type: 'environment', id: development.id })
        )
      ).toBe(true)
      const duplicate = environment(created.id, 'development')
      expect(
        await plane.createEnvironment(
          duplicate,
          activity('environment.created', { type: 'environment', id: duplicate.id })
        )
      ).toBe(false)
      const listed = await plane.listEnvironments({ projectId: created.id, page: 1, size: 10 })
      expect(listed.items).toEqual([development])
      expect((await actions()).filter((type) => type === 'environment.created')).toHaveLength(1)
    })

    test('the audit list is newest first and filters by action, target and time', async () => {
      const targetId = Bun.randomUUIDv7()
      await plane.record(activity('instance.signed_in', null, { occurredAt: at(1) }))
      await plane.record(
        activity(
          'project.renamed',
          { type: 'project', id: targetId },
          { occurredAt: at(2), data: { changed: ['name'] } }
        )
      )
      await plane.record(activity('instance.signed_out', null, { occurredAt: at(3) }))

      const all = await plane.listAudit({ actorId, page: 1, size: 10 })
      expect(all.items.map((entry) => entry.type)).toEqual([
        'instance.signed_out',
        'project.renamed',
        'instance.signed_in',
      ])
      expect(all.totalCount).toBe(3)
      expect(all.items[1]).toMatchObject({
        actor: { type: 'instance_admin', id: actorId },
        target: { type: 'project', id: targetId },
        ipAddress: '203.0.113.9',
        userAgent: 'suite/1.0',
        data: { changed: ['name'] },
        occurredAt: at(2),
      })
      expect(all.items[0]?.target).toBeNull()

      const byAction = await plane.listAudit({
        actorId,
        action: 'instance.signed_in',
        page: 1,
        size: 10,
      })
      expect(byAction.items.map((entry) => entry.type)).toEqual(['instance.signed_in'])
      const byTarget = await plane.listAudit({ targetId, page: 1, size: 10 })
      expect(byTarget.items.map((entry) => entry.type)).toEqual(['project.renamed'])
      // `from` is inclusive, `to` exclusive.
      const window = await plane.listAudit({ actorId, from: at(2), to: at(3), page: 1, size: 10 })
      expect(window.items.map((entry) => entry.type)).toEqual(['project.renamed'])
      const pageTwo = await plane.listAudit({ actorId, page: 2, size: 2 })
      expect(pageTwo.items.map((entry) => entry.type)).toEqual(['instance.signed_in'])
      expect(pageTwo.totalCount).toBe(3)
    })

    test('an entry without an actor id (the admin token itself) is stored', async () => {
      const id = Bun.randomUUIDv7()
      await plane.record(
        activity('instance.sign_in_failed', null, {
          id,
          actor: { type: 'instance_admin', id: null },
          ipAddress: null,
          userAgent: null,
          occurredAt: at(9),
        })
      )
      const { items } = await plane.listAudit({
        action: 'instance.sign_in_failed',
        from: at(9),
        page: 1,
        size: 100,
      })
      expect(items.find((entry) => entry.id === id)).toMatchObject({
        actor: { type: 'instance_admin', id: null },
        ipAddress: null,
        userAgent: null,
      })
    })
  })
}
