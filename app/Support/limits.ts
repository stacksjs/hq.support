export type Plan = 'free' | 'trial' | 'starter' | 'growth' | 'enterprise' | 'selfhost'

export const plans = {
  free: { monthlyCents: 0, annualCents: 0, seats: 2, conversations: 100, conversationCeiling: 120, ai: 10, storageBytes: 300_000_000, fileBytes: 10_000_000, projects: 1 },
  starter: { monthlyCents: 4900, annualCents: 49000, seats: 5, conversations: 1000, conversationCeiling: 1000, ai: 100, storageBytes: 5_000_000_000, fileBytes: 25_000_000, projects: 3 },
  growth: { monthlyCents: 19900, annualCents: 199000, seats: 15, conversations: 5000, conversationCeiling: 5000, ai: 500, storageBytes: 25_000_000_000, fileBytes: 25_000_000, projects: 10 },
  enterprise: { monthlyCents: 99900, annualCents: 999000, seats: 50, conversations: 25000, conversationCeiling: 25000, ai: 2500, storageBytes: 100_000_000_000, fileBytes: 50_000_000, projects: null },
  selfhost: { monthlyCents: 0, annualCents: 0, seats: null, conversations: null, conversationCeiling: null, ai: null, storageBytes: null, fileBytes: null, projects: null },
} as const
export const billingPolicy = { trialDays: 14, extraSeatCents: 1000, conversationBlockSize: 1000, conversationBlockCents: 1000, aiConversationCents: 39, aiMaxTurns: 20, aiMaxTokens: 20_000, minimumWalletTopupCents: 2000, managedMarkupPercent: 15, enterpriseSelfhostMonthlyCents: 29900 } as const

export function limitsFor(plan: Plan) { return plans[plan === 'trial' ? 'growth' : plan] }
export function periodOf(date = new Date()) { return date.toISOString().slice(0, 7) }
