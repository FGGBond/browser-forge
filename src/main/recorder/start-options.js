export async function resolveStartOptions({ chromePath, outputDir, port, findChromePath }) {
  const resolvedChromePath = String(chromePath || '').trim() || await findChromePath()
  return {
    chromePath: resolvedChromePath,
    ...(outputDir === undefined ? {} : { outputDir }),
    port
  }
}
