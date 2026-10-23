import '../playground/playground.css'

// The playground's entry. A page loads it only when it holds a `[data-playground]` placeholder
// (the build adds this script and its stylesheet to those pages and no others). It is a few
// hundred bytes: the island itself (React, the client, the components, the sandbox) is a
// separate chunk that is fetched when a placeholder is about to scroll into view, so that a
// page with a playground far down does not pay for it until the reader gets near.

const NEAR = '600px'

function load(host: HTMLElement): void {
  if (host.dataset.state) {
    return
  }
  host.dataset.state = 'loading'
  import('../playground/ui/mount').then(
    ({ mount }) => mount(host),
    () => {
      host.dataset.state = 'failed'
    }
  )
}

function start(): void {
  const hosts = document.querySelectorAll<HTMLElement>('[data-playground]')
  if (!('IntersectionObserver' in window)) {
    hosts.forEach(load)
    return
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target)
          load(entry.target as HTMLElement)
        }
      }
    },
    { rootMargin: NEAR }
  )
  for (const host of hosts) {
    observer.observe(host)
  }
}

start()
