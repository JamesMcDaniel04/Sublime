// Web push service worker for SprintIQ notifications.
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = data.title || 'SprintIQ'
  const options = {
    body: data.body || '',
    data: { url: data.url || '/dashboard' },
    tag: data.tag || undefined,
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/dashboard'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Prefer a window already showing the target page; otherwise focus an
      // existing window AND navigate it to the notification's deep link —
      // focusing alone would leave the user wherever they happened to be.
      const target = new URL(url, self.location.origin).href
      for (const client of list) {
        if (client.url === target && 'focus' in client) return client.focus()
      }
      for (const client of list) {
        if ('focus' in client && 'navigate' in client) {
          return client.focus().then((focused) => focused.navigate(target)).catch(() => self.clients.openWindow(url))
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
