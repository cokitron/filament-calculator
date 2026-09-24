import { loadConfig, ConfigError } from './config'
import { createApp } from './index'

/**
 * Process entry point.
 *
 * Kept separate from index.ts so that importing the app in a test never starts
 * a listener or reads the real environment.
 */
function main(): void {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      // Exit non-zero and loudly. On Railway this shows as a failed deploy,
      // which is the correct outcome: better no service than an unlocked one.
      console.error(`\n[printdesk] REFUSING TO START\n\n  ${err.message}\n`)
      process.exit(78) // EX_CONFIG
    }
    throw err
  }

  for (const warning of config.warnings) console.warn(`[config] WARNING: ${warning}`)

  const app = createApp(config)
  void app.listen().then(({ port, close }) => {
    console.log(`[printdesk] listening on :${port}`)
    console.log(`[printdesk] database   ${config.databasePath}`)
    console.log(`[printdesk] static     ${config.staticDir}`)
    console.log(`[printdesk] cookies    ${config.secureCookies ? 'Secure' : 'INSECURE (local only)'}`)

    // Railway sends SIGTERM on redeploy. Closing the database explicitly
    // checkpoints the WAL, so the next container starts from a clean file.
    const shutdown = (signal: string) => () => {
      console.log(`[printdesk] ${signal} received, closing database`)
      void close().then(() => process.exit(0))
    }
    process.on('SIGTERM', shutdown('SIGTERM'))
    process.on('SIGINT', shutdown('SIGINT'))
  })
}

main()
