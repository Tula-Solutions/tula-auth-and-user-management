import { createAdminClient } from '@tula-tech/admin'

// The native-app calls shown in docs/native-apps.md, through `@tula-tech/admin`. Copied by
// region (`bun run docs:generate`) and compiled by `bun run typecheck:scripts`. Nothing here runs.

/** The environment's secret key (`tula_sk_…`), read from the server's own configuration. */
declare const secretKey: string

const admin = createAdminClient({ baseUrl: 'https://auth.example.com', secretKey })

/** Register an iOS app. */
export async function registerIosApp() {
  // #region native-app-register
  const { data: app } = await admin.call('createNativeApp', {
    body: { platform: 'ios', teamId: 'A1B2C3D4E5', bundleId: 'app.northline.ios' },
  })
  // #endregion
  return app
}

/** Give an app one link path of the domain. */
export async function setLinkPaths(appId: string) {
  // #region native-app-link-paths
  await admin.call('updateNativeApp', {
    params: { id: appId },
    body: { appLinkPaths: ['/oauth/callback'] },
  })
  // #endregion
}
