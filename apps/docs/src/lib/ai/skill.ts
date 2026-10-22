import { RenderError } from '../markdown'
import { fileUrl, twinUrl, type Urls } from './urls'

/** Where the skill's text is kept, relative to the repository root. */
export const SKILL_SOURCE = 'apps/docs/content/skill.md'

const PLACEHOLDER = /\{\{(page|file):([^}\s]+)\}\}/g

/**
 * Write `skill.md` from its source: a text that teaches an agent to add Tula Auth to a project.
 *
 * The source holds no address. `{{page:docs/quickstart.md}}` (or `{{page:/reference/error-codes/}}`, for a page with no file) becomes the address of that
 * page's Markdown twin and `{{file:llms.txt}}` the address of a file the build writes, both
 * under the base, so that a page the skill points at must exist: a placeholder that names none
 * stops the build.
 *
 * @param source - The text of {@link SKILL_SOURCE}.
 * @param routes - The route of every Markdown file that is a page, by file.
 * @param files - The files the build writes, by path from the site's root.
 * @param urls - The origin and the base.
 * @returns The skill, with every address absolute.
 * @throws RenderError for a placeholder that names no page or file.
 */
export function buildSkill(
  source: string,
  routes: ReadonlyMap<string, string>,
  files: ReadonlySet<string>,
  urls: Urls
): string {
  return source.replace(PLACEHOLDER, (_match, kind: string, name: string) => {
    if (kind === 'file') {
      if (!files.has(name)) {
        throw new RenderError(
          SKILL_SOURCE,
          `names the file "${name}", which the build does not write`
        )
      }
      return fileUrl(urls, name)
    }
    const [file = '', fragment = ''] = name.split('#')
    const route = routes.get(file)
    if (route === undefined) {
      throw new RenderError(
        SKILL_SOURCE,
        `names the page "${file}", which is not a page of the site`
      )
    }
    return twinUrl(urls, route, fragment)
  })
}
