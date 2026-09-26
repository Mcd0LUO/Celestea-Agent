// i18n/locales/en/usage.ts — the settings "Usage" domain (English).
export const usage = {
  'usage.nav.title': 'Usage',
  'usage.nav.note': 'Lifetime usage and daily activity',
  // ---- summary strip ----
  'usage.summary.totalTokens': 'Total tokens',
  'usage.summary.peakTokens': 'Peak tokens',
  'usage.summary.longestSession': 'Longest chat',
  'usage.summary.currentStreak': 'Current streak',
  'usage.summary.longestStreak': 'Longest streak',
  'usage.summary.cost': 'Estimated cost',
  // Cost: an unknown price is NOT 0, so "unpriced" and "¥0" are different sentences.
  'usage.cost.unpriced': 'Unpriced',
  'usage.cost.unpricedHint':
    '{models} is not in the price table, so no amount can be shown (unknown, not 0).',
  'usage.cost.unsupportedHint':
    'This deployment has no usable price table, so no amount can be shown.',
  // ---- heatmap ----
  'usage.heatmap.title': 'Token activity',
  'usage.heatmap.mode.daily': 'Daily',
  'usage.heatmap.mode.weekly': 'Weekly',
  'usage.heatmap.mode.cumulative': 'Cumulative',
  'usage.heatmap.cellBase': '{date} · {tokens}',
  'usage.heatmap.weekBase': 'Week ending {date} · {tokens}',
  'usage.heatmap.cumulativeBase': 'Through {date} · {tokens} total',
  'usage.heatmap.partTurns': '{turns} turns',
  'usage.heatmap.partTools': '{tools} tool calls',
  'usage.heatmap.less': 'Less',
  'usage.heatmap.more': 'More',
  // ---- range ----
  'usage.range.title': 'Time range',
  'usage.range.7d': 'Last 7 days',
  'usage.range.30d': 'Last 30 days',
  // ---- trend ----
  'usage.trend.title': 'Daily token trend',
  'usage.trend.unknownModel': 'Unknown model',
  // ---- actions ----
  'usage.action.refresh': 'Refresh',
  // ---- empty / degraded ----
  'usage.empty.title': 'No usage yet',
  'usage.empty.desc': 'Statistics appear here once a conversation has used tokens.',
  'usage.ledger.disabled': 'The usage ledger is turned off, so there are no statistics to show.',
  'usage.ledger.unavailable':
    'This deployment has no usage ledger, so there are no statistics to show.',
  'usage.ledger.unreadable': 'The usage ledger cannot be read right now; please try again later.',
  // ---- units ----
  'usage.unit.day': 'd',
  'usage.unit.hour': 'h',
  'usage.unit.minute': 'min',
  'usage.unit.tokens': 'tokens',
};
