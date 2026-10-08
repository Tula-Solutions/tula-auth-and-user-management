// What `@tula/admin` resolves to under the `browser` export condition. A bundler building for
// a web page takes this file instead of the client, so the build (or the first import) fails
// here instead of shipping a secret key to every visitor. The client also refuses at run time
// (`createAdminClient` throws `client.browser` where `window` and `document` exist), for a
// bundler that ignores the condition.
throw new Error(
  '@tula/admin holds a secret key and must not be bundled for a browser. ' +
    'Import it only from server code (a route handler, a server action, a script).'
)

// Never reached. It makes this file a module, so the throw above is not a top-level script.
export {}
