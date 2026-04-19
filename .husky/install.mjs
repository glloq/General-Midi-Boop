// Skip husky install in production and CI environments,
// and when the husky package itself isn't installed
// (e.g. `npm ci --omit=dev`).
if (process.env.NODE_ENV === 'production' || process.env.CI === 'true') {
  process.exit(0)
}
try {
  const husky = (await import('husky')).default
  console.log(husky())
} catch (e) {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e
}
