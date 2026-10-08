/** The route groups a dashboard session is accepted on (ADR 0032). */
const DASHBOARD_PREFIXES = ['/v1/admin/', '/v1/instance/']

interface OpenApiDocument {
  paths?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Keep only the operations the dashboard may call, so no hook exists for a client route.
 *
 * Orval's input transformer: it must be the module's default export.
 *
 * @param document - The contract's OpenAPI document.
 * @returns The same document with every other path removed.
 */
export default function dashboardOperations(document: OpenApiDocument): OpenApiDocument {
  const paths = Object.fromEntries(
    Object.entries(document.paths ?? {}).filter(([path]) =>
      DASHBOARD_PREFIXES.some((prefix) => path.startsWith(prefix))
    )
  )
  return { ...document, paths }
}
