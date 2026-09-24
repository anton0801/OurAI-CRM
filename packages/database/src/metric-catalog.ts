/**
 * System metric catalog (section 15.2). Keys are namespaced by entity so that, for example,
 * account period views and publication cumulative views are never mixed.
 */
export interface MetricCatalogEntry {
  key: string;
  version: number;
  label: string;
  description: string;
  entityType: 'account' | 'publication' | 'ofm_account';
  observationKind: 'snapshot' | 'period' | 'cumulative';
  unit: string;
  valueType: 'integer' | 'decimal' | 'money' | 'duration_seconds';
  aggregation: 'sum_non_overlapping' | 'last_snapshot' | 'checkpoint_value' | 'none';
}

const e = (
  key: string,
  label: string,
  description: string,
  entityType: MetricCatalogEntry['entityType'],
  observationKind: MetricCatalogEntry['observationKind'],
  unit: string,
  valueType: MetricCatalogEntry['valueType'],
  aggregation: MetricCatalogEntry['aggregation'],
): MetricCatalogEntry => ({ key, version: 1, label, description, entityType, observationKind, unit, valueType, aggregation });

export const METRIC_CATALOG: MetricCatalogEntry[] = [
  // Account snapshot
  e('account.followers', 'Followers', 'Followers at the moment of observation.', 'account', 'snapshot', 'count', 'integer', 'last_snapshot'),
  e('account.following', 'Following', 'Accounts followed at the moment of observation.', 'account', 'snapshot', 'count', 'integer', 'last_snapshot'),
  e('account.total_posts', 'Total posts', 'Posts shown on the profile at observation time.', 'account', 'snapshot', 'count', 'integer', 'last_snapshot'),
  e('account.active_paid_subscribers', 'Active paid subscribers', 'Active paying subscribers at observation time.', 'account', 'snapshot', 'count', 'integer', 'last_snapshot'),
  // Account period
  e('account.views', 'Views', 'Views reported for the account over the period.', 'account', 'period', 'count', 'integer', 'sum_non_overlapping'),
  e('account.impressions', 'Impressions', 'Impressions reported over the period.', 'account', 'period', 'count', 'integer', 'sum_non_overlapping'),
  e('account.reach', 'Reach', 'Reach reported by the platform over the period (not unique people across periods).', 'account', 'period', 'count', 'integer', 'none'),
  e('account.profile_visits', 'Profile visits', 'Profile visits reported over the period.', 'account', 'period', 'count', 'integer', 'sum_non_overlapping'),
  e('account.link_clicks', 'Link clicks', 'Link clicks reported over the period.', 'account', 'period', 'count', 'integer', 'sum_non_overlapping'),
  e('account.new_follows', 'New follows', 'New follows over the period.', 'account', 'period', 'count', 'integer', 'sum_non_overlapping'),
  e('account.unfollows', 'Unfollows', 'Unfollows over the period.', 'account', 'period', 'count', 'integer', 'sum_non_overlapping'),
  e('account.watch_time_seconds', 'Watch time', 'Total watch time over the period.', 'account', 'period', 'seconds', 'duration_seconds', 'sum_non_overlapping'),
  e('account.platform_conversions', 'Platform-reported conversions', 'Conversions as reported by the platform.', 'account', 'period', 'count', 'integer', 'sum_non_overlapping'),
  // Publication cumulative
  e('publication.views', 'Views', 'Cumulative views of the publication at observation time.', 'publication', 'cumulative', 'count', 'integer', 'checkpoint_value'),
  e('publication.impressions', 'Impressions', 'Cumulative impressions at observation time.', 'publication', 'cumulative', 'count', 'integer', 'checkpoint_value'),
  e('publication.reach', 'Reach', 'Cumulative reported reach at observation time.', 'publication', 'cumulative', 'count', 'integer', 'checkpoint_value'),
  e('publication.likes', 'Likes', 'Cumulative likes.', 'publication', 'cumulative', 'count', 'integer', 'checkpoint_value'),
  e('publication.comments', 'Comments', 'Cumulative comments.', 'publication', 'cumulative', 'count', 'integer', 'checkpoint_value'),
  e('publication.shares', 'Shares', 'Cumulative shares.', 'publication', 'cumulative', 'count', 'integer', 'checkpoint_value'),
  e('publication.saves', 'Saves', 'Cumulative saves.', 'publication', 'cumulative', 'count', 'integer', 'checkpoint_value'),
  e('publication.total_watch_time_seconds', 'Total watch time', 'Cumulative watch time.', 'publication', 'cumulative', 'seconds', 'duration_seconds', 'checkpoint_value'),
  e('publication.average_watch_time_seconds', 'Average watch time (source-reported)', 'Average watch time as reported by the source.', 'publication', 'cumulative', 'seconds', 'decimal', 'none'),
  e('publication.completions', 'Completed views', 'Completed views as reported by the source.', 'publication', 'cumulative', 'count', 'integer', 'checkpoint_value'),
  e('publication.clicks', 'Clicks', 'Cumulative link clicks.', 'publication', 'cumulative', 'count', 'integer', 'checkpoint_value'),
  // OFM period
  e('ofm.new_paid_subscribers', 'New paid subscribers', 'Confirmed new paid subscriptions in the period.', 'ofm_account', 'period', 'count', 'integer', 'sum_non_overlapping'),
  e('ofm.renewals', 'Renewals', 'Confirmed renewals in the period.', 'ofm_account', 'period', 'count', 'integer', 'sum_non_overlapping'),
  e('ofm.eligible_renewals', 'Subscriptions eligible to renew', 'Subscriptions whose renewal fell into the period.', 'ofm_account', 'period', 'count', 'integer', 'sum_non_overlapping'),
  e('ofm.cancellations', 'Cancellations', 'Confirmed cancellations in the period.', 'ofm_account', 'period', 'count', 'integer', 'sum_non_overlapping'),
  e('ofm.starting_active_subscribers', 'Starting active subscribers', 'Active subscribers at the start of the period (cohort base).', 'ofm_account', 'period', 'count', 'integer', 'none'),
  e('ofm.lost_from_starting_cohort', 'Lost from starting cohort', 'Confirmed losses among the starting active cohort.', 'ofm_account', 'period', 'count', 'integer', 'none'),
  e('ofm.purchases', 'Purchases', 'Confirmed purchases in the period.', 'ofm_account', 'period', 'count', 'integer', 'sum_non_overlapping'),
  e('ofm.gross_sales', 'Gross sales (reported)', 'Platform-reported gross sales (analytics only, not ledger).', 'ofm_account', 'period', 'money', 'money', 'sum_non_overlapping'),
  e('ofm.refunds', 'Refunds (reported)', 'Platform-reported refunds (analytics only).', 'ofm_account', 'period', 'money', 'money', 'sum_non_overlapping'),
  e('ofm.platform_fees', 'Platform fees (reported)', 'Platform-reported fees (analytics only).', 'ofm_account', 'period', 'money', 'money', 'sum_non_overlapping'),
];

export const METRIC_KEYS = new Set(METRIC_CATALOG.map((m) => m.key));
export const metricByKey = (key: string): MetricCatalogEntry | undefined => METRIC_CATALOG.find((m) => m.key === key);
