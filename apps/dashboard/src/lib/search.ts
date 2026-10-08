/**
 * Read the `page` search parameter of a paged screen.
 *
 * @param search - The route's raw search parameters.
 * @returns `{ page }` for a whole number above 1; nothing otherwise (page 1 is the default
 *   and is left out of the address).
 */
export function pageSearch(search: Record<string, unknown>): { page?: number } {
  const page = Number(search.page)
  return Number.isInteger(page) && page > 1 ? { page } : {}
}
