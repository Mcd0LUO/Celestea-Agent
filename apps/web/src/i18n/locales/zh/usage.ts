// i18n/locales/zh/usage.ts — 设置页「使用统计」域。
//   文案口径：只说用户看得懂的事（用量、天数、轮数），不提数据来源与实现细节。
//   tooltip 用「基础句 + 可选片段」拼装（见 ui/usage/heatmap.ts）：轮数与工具次数
//   账本不提供 ⇒ 整段省略，而不是显示 0（0 会被读成「确实没有」）。
export const usage = {
  'usage.nav.title': '使用统计',
  'usage.nav.note': '累计用量与每日活动',
  // ---- 摘要条（5 格） ----
  'usage.summary.totalTokens': '累计 Token 数',
  'usage.summary.peakTokens': '峰值 Token 数',
  'usage.summary.longestSession': '最长聊天时长',
  'usage.summary.currentStreak': '当前连续天数',
  'usage.summary.longestStreak': '最长连续天数',
  'usage.summary.cost': '费用估算',
  // 费用：未知价格**不是 0**，所以「未定价」与「¥0」是两句不同的话。
  'usage.cost.unpriced': '未定价',
  'usage.cost.unpricedHint': '{models} 不在价格表内，因此没有金额可显示（未知，不是 0）。',
  'usage.cost.unsupportedHint': '当前部署没有可用的价格表，因此没有金额可显示。',
  // ---- 热力图 ----
  'usage.heatmap.title': 'Token 活动',
  'usage.heatmap.mode.daily': '每日',
  'usage.heatmap.mode.weekly': '每周',
  'usage.heatmap.mode.cumulative': '累计',
  'usage.heatmap.cellBase': '{date} · {tokens}',
  'usage.heatmap.weekBase': '{date} 止的一周 · {tokens}',
  'usage.heatmap.cumulativeBase': '截至 {date} · 累计 {tokens}',
  'usage.heatmap.partTurns': '{turns} 轮',
  'usage.heatmap.partTools': '工具 {tools} 次',
  'usage.heatmap.less': '少',
  'usage.heatmap.more': '多',
  // ---- 时间范围 ----
  'usage.range.title': '时间范围',
  'usage.range.7d': '近 7 日',
  'usage.range.30d': '近 30 日',
  // ---- 趋势图 ----
  'usage.trend.title': '每日 Token 趋势',
  'usage.trend.unknownModel': '未知模型',
  // ---- 动作 ----
  'usage.action.refresh': '刷新',
  // ---- 空态 / 降级 ----
  'usage.empty.title': '暂无用量记录',
  'usage.empty.desc': '有对话产生用量后，这里会显示统计。',
  'usage.ledger.disabled': '用量账本已关闭，因此没有可显示的统计。',
  'usage.ledger.unavailable': '当前部署没有用量账本，因此没有可显示的统计。',
  'usage.ledger.unreadable': '用量账本暂时读不出来，请稍后重试。',
  // ---- 单位 ----
  'usage.unit.day': '天',
  'usage.unit.hour': '小时',
  'usage.unit.minute': '分钟',
  'usage.unit.tokens': 'Token',
} as const;
