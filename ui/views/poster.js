export function bindPosterFallbacks(root) {
  root.querySelectorAll('[data-poster]').forEach(image => {
    const hideBrokenPoster = () => { image.hidden = true }
    image.addEventListener('error', hideBrokenPoster, { once: true })
    if (image.complete && image.naturalWidth === 0) hideBrokenPoster()
  })
}
