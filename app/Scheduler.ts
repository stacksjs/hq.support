import process from 'node:process'
import { schedule } from '@stacksjs/scheduler'

/**
 * **Scheduler**
 *
 * Define your scheduled tasks here. Jobs, actions, and shell commands
 * can all be scheduled with a fluent, expressive API.
 *
 * @see https://docs.stacksjs.com/scheduling
 */
export default function (): void {
  schedule.job('ApplyEnterpriseRetention').hourly().onQueue('support-retention').withoutOverlapping().onOneServer()
  schedule.job('PruneInboxPresence').everyFiveMinutes().onQueue('support-retention').withoutOverlapping().onOneServer()
  schedule.job('RunSupportWorkflows').everyMinute().onQueue('support-workflows').withoutOverlapping().onOneServer()
  schedule.job('DrainInboxOverflow').everyMinute().onQueue('support-workflows').withoutOverlapping().onOneServer()
  schedule.job('ReopenSnoozedConversations').everyMinute().onQueue('support-workflows').withoutOverlapping().onOneServer()
  schedule.job('RunSupportImport').everyMinute().onQueue('support-imports').withoutOverlapping().onOneServer()
  schedule.job('RunChannelDelivery').everyMinute().onQueue('support-channels').withoutOverlapping().onOneServer()
  schedule.job('RunTicketSla').everyMinute().onQueue('support-sla').withoutOverlapping().onOneServer()
  schedule.job('RunSupportEmail').everyMinute().onQueue('support-email').withoutOverlapping().onOneServer()
  schedule.job('IndexSupportKnowledge').everyMinute().onQueue('support-knowledge').withoutOverlapping().onOneServer()
  // Run the Inspire job every hour. An example, so it ships commented out
  // like the others: live, it put an always-on scheduler daemon on every
  // deploy of every new app, and `buddy new --minimal` (which removes
  // app/Jobs) left it naming a job that no longer exists.
  // schedule.job('Inspire').hourly().setTimeZone('America/Los_Angeles')

  // Run a custom action every five minutes
  // schedule.action('CleanupTempFiles').everyFiveMinutes()

  // Run a shell command daily at midnight
  // schedule.command('echo "Daily maintenance complete"').daily()
}

process.on('SIGINT', () => {
  schedule.gracefulShutdown().then(() => process.exit(0))
})
