import supportConfig from '../../config/support'
import { billingPolicy } from './limits'
import { fail } from './errors'

export function selfHostedDeployment(): boolean {
  // Exact opt-in only. Invalid/missing values can never enable uncapped core.
  return supportConfig.deploymentMode === 'selfhost'
}
export function initialWorkspaceEntitlement(now = Date.now()) {
  return selfHostedDeployment()
    ? { plan: 'selfhost' as const, trial_ends_at: 0 }
    : { plan: 'trial' as const, trial_ends_at: now + billingPolicy.trialDays * 86400000 }
}
export function requireHostedSubscription() {
  if (selfHostedDeployment()) fail(409, 'hosted_subscription_unavailable', 'Hosted subscriptions do not apply to this self-hosted installation. Enterprise features require their separate installation license.')
}
