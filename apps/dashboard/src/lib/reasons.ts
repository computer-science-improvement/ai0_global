// Spec 073 FR-014: the dashboard's mirror of the server's reason catalogue (apps/automation/src/editor/reasons/catalogue.ts):
// { code, en, fix.en, link } for each code a slot, a plan or a channel can stop on. Labels are read from here only. The
// Ukrainian texts stay on the server (the owner bot sends them). reasons.test.ts reads the server file and fails when an `en`,
// a fix or a link changes there without the same change here.

import { isAgentTab, type AgentTab } from './agent-tabs';
import { isDataTab, type DataTab } from './data-tabs';
import { INBOX_TABS, type InboxTab } from './inbox-view';

export interface ReasonView {
  code: string;
  /** The label. */
  en:   string;
  /** One sentence: what to change. */
  fix?: { en: string };
  /** A dashboard path template with `:channel`, `:agent` or `:dataset`, and an optional `?tab=`. */
  link?: string;
}

export const REASONS: readonly ReasonView[] = [
  { code: 'critic', en: 'Stopped by the critic', fix: { en: 'Read the critic notes on the slot and adjust the brief or the skills that shaped the post.' }, link: '/app/editor/:channel' },
  { code: 'lint', en: 'Text checks failed', fix: { en: 'Open the slot to see which check failed and fix the brief or the skill that causes it.' }, link: '/app/editor/:channel' },
  { code: 'config', en: 'Setup problem', fix: { en: 'Open the slot to see what is wrong with the setup of the series and change it there.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'cap', en: 'A posting limit applied', fix: { en: 'Check the limits and quiet hours in the channel card.' }, link: '/app/editor/:channel' },
  { code: 'nothing_fresh', en: 'Nothing fresh to post', fix: { en: 'Add material for the series: rows in its dataset or another source.' }, link: '/app/editor/:channel' },
  { code: 'budget', en: 'Skipped over the budget', fix: { en: 'Raise the daily budget or wait for it to reset.' } },
  { code: 'other', en: 'Skipped by the agent — other reason', fix: { en: 'Open the slot to read the explanation the agent gave.' } },
  { code: 'no_material', en: 'Skipped by the agent — no material', fix: { en: 'Add material: rows in the dataset or another source for the series.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'source_unreachable', en: 'Skipped by the agent — source unreachable', fix: { en: 'Check that the source opens, or add another source.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'source_used', en: 'Skipped by the agent — source already used', fix: { en: 'Add another source or wait for new items.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'quality', en: 'Skipped by the agent — weak material', fix: { en: 'Add stronger material for this series.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'skipped_by_agent', en: 'Skipped by the agent', fix: { en: 'Open the slot to read the explanation the agent gave.' } },
  { code: 'skipped_by_owner', en: 'Skipped by you' },
  { code: 'lint_failed', en: 'Post failed the text checks', fix: { en: 'Open the slot to see which check failed and fix the brief or the skill that causes it.' }, link: '/app/editor/:channel' },
  { code: 'guard_failed', en: 'Publishing guard refused the post', fix: { en: 'Open the slot to see which guard refused the post.' }, link: '/app/editor/:channel' },
  { code: 'too_similar', en: 'Too similar to a recent post', fix: { en: 'Give the slot a different angle or source so that it does not repeat a recent post.' } },
  { code: 'too_verbatim', en: 'Copies its source too closely', fix: { en: 'Ask for a retelling in the channel voice, or mark the text as a quotation with its source.' } },
  { code: 'source_already_posted', en: 'Source already posted', fix: { en: 'Add another source or let the series take the next item.' } },
  { code: 'library_item_already_posted', en: 'Library row already posted', fix: { en: 'Add rows to the dataset or point the series at another one.' }, link: '/app/data/:dataset' },
  { code: 'already_posted', en: 'Already posted', fix: { en: 'Pick a different item for this slot.' } },
  { code: 'quiz_answer_mismatch', en: 'Quiz answer does not match the dataset', fix: { en: 'Mark the answer that the dataset row gives and do not correct it from memory.' }, link: '/app/data/:dataset' },
  { code: 'library_ref_not_found', en: 'Library row not found', fix: { en: 'Check that the slot names a row that exists in the dataset.' }, link: '/app/data/:dataset' },
  { code: 'series_source_mismatch', en: 'The post source is not the series source', fix: { en: 'Make the post use the source the series names, or change the source of the series.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'live_source_missing', en: 'Live slot without its source', fix: { en: 'Add the feed the live slot reads, or turn the slot into a plain one.' } },
  { code: 'not_next_in_order', en: 'Row is not next in the series order', fix: { en: 'Take the row the series names as next, or set the series to random order.' }, link: '/app/data/:dataset' },
  { code: 'preflight_no_material', en: 'Nothing to post from the library row', fix: { en: 'Add rows with the fields this series needs, or change its source.' }, link: '/app/data/:dataset' },
  { code: 'preflight_source_used', en: 'Source already used', fix: { en: 'Add another source or wait for new items.' } },
  { code: 'preflight_stale', en: 'Source is too old', fix: { en: 'Add a fresher source or raise the age limit in the channel card.' }, link: '/app/editor/:channel' },
  { code: 'preflight_host_blocked', en: 'Source site is blocking us', fix: { en: 'Add another source for the series; the site is tried again after the block expires.' } },
  { code: 'preflight_format_unavailable', en: 'Format cannot be produced here', fix: { en: 'Set up what the format needs (for a carousel, slide hosting) or change the format of the series.' }, link: '/app/editor/:channel' },
  { code: 'daily_cap_reached', en: 'Daily post limit reached', fix: { en: 'Raise the maximum posts per day in the channel card if more should go out.' }, link: '/app/editor/:channel' },
  { code: 'poll_cap_reached', en: 'Weekly poll limit reached', fix: { en: 'Raise the poll limit in the channel card, or make the question a series, which the limit does not cover.' }, link: '/app/editor/:channel' },
  { code: 'min_gap', en: 'Too soon after the previous post', fix: { en: 'Lower the minimum gap in the channel card or move the slots further apart.' }, link: '/app/editor/:channel' },
  { code: 'quiet_hours', en: 'Inside quiet hours', fix: { en: 'Move the slot out of the quiet hours or change them in the channel card.' }, link: '/app/editor/:channel' },
  { code: 'blackout_window', en: 'Inside a blackout window', fix: { en: 'Move the slot or change the blackout rule in the schedule.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'critic_rejected', en: 'Rejected by the critic', fix: { en: 'Read the critic notes on the slot and adjust the brief or the sources if the same reason repeats.' }, link: '/app/editor/:channel' },
  { code: 'critic_failed', en: 'Critic unavailable — held', fix: { en: 'Check that the critic model answers; the post is held until then.' } },
  { code: 'budget_exceeded', en: 'Budget exhausted', fix: { en: 'Raise the daily budget or wait for it to reset.' } },
  { code: 'waiting_for_budget', en: 'Waiting for budget', fix: { en: 'Raise the daily budget or wait; the slot tries again by itself.' } },
  { code: 'no_fresh_item', en: 'Nothing fresh in the sources', fix: { en: 'Add a source that publishes more often, or raise the maximum age in the channel card.' }, link: '/app/editor/:channel' },
  { code: 'source_not_published', en: 'Source post not published yet', fix: { en: 'Wait for the source post to go out first.' } },
  { code: 'required_source_empty', en: 'Required source of the series has nothing left', fix: { en: 'Add rows or items to the source, or change the source of the series.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'host_blocked', en: 'Source site is blocked', fix: { en: 'Add another source; the site is tried again when the block expires.' } },
  { code: 'feed_too_large', en: 'Source is too large to read', fix: { en: 'Use a smaller feed or another source.' } },
  { code: 'fetch_failed', en: 'Source could not be fetched', fix: { en: 'Check that the source opens, or add another one.' } },
  { code: 'story_skip', en: 'Story already told', fix: { en: 'Give the slot a different topic.' } },
  { code: 'story_repeat', en: 'Story repeats an earlier post', fix: { en: 'Give the slot a different topic.' } },
  { code: 'superseded', en: 'Replaced by a newer plan' },
  { code: 'mode_changed', en: 'Channel mode changed' },
  { code: 'draft_canceled', en: 'Draft canceled' },
  { code: 'series_paused', en: 'Series paused', fix: { en: 'Resume the series when its material is back.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'rejected_by_owner', en: 'Rejected by you' },
  { code: 'resource_paused', en: 'Resource paused', fix: { en: 'Resume the resource to plan posts for it again.' }, link: '/app/agents/:agent' },
  { code: 'agent_paused', en: 'Agent paused', fix: { en: 'Resume the agent so that its slots run again.' }, link: '/app/agents/:agent' },
  { code: 'resource_unavailable', en: 'Connection broken', fix: { en: 'Reconnect the resource in Connections.' } },
  { code: 'planner_no_material', en: 'Declared empty by the planner', fix: { en: 'Add material for the series, or pause it until there is some.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'planner_source_unreachable', en: 'Declared empty by the planner (sources unreadable)', fix: { en: 'Check that the sources of the series open, or add another one.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'planner_skipped', en: 'Skipped by the planner', fix: { en: 'Read the reason the planner gave on the slot, and fix what it names.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'series_format_unavailable', en: 'Series format cannot be produced here', fix: { en: 'Set up what the format needs, or change the format of the series.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'series_in_quiet_hours', en: 'Series time falls in quiet hours', fix: { en: 'Move the time of the series out of the quiet hours, or change the quiet hours in the channel card.' }, link: '/app/editor/:channel' },
  { code: 'config_series_gone', en: 'Series is gone or switched off', fix: { en: 'Switch the series on again, or take its leftover slots out of the plan.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'config_format_mismatch', en: 'Slot format differs from the series format', fix: { en: 'Let the slot take the format of the series, or change the format of the series.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'config_source_mismatch', en: 'Slot source is not the source of the series', fix: { en: 'Point the slot at the source the series names, or change the source of the series.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'config_source_missing', en: 'Source of the series does not exist', fix: { en: 'Create the dataset the series names, or point the series at one that exists.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'config_tools_missing', en: 'Agent lacks the tool its source needs', fix: { en: 'Give the agent the read tool the source needs, or change the source of the series.' }, link: '/app/agents/:agent?tab=loadout' },
  { code: 'series_format_mismatch', en: 'Post format is not the series format', fix: { en: 'Write the post in the format the series names, or change the format of the series.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'series_rate_over_card_max', en: 'Series publishes more often than the card allows', fix: { en: 'Raise the maximum posts per day in the channel card, or space the series out.' }, link: '/app/editor/:channel' },
  { code: 'series_stalled', en: 'Series has not gone out two days in a row', fix: { en: 'Open the latest skipped slot of the series to see why it stops.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'retrying', en: 'Retrying after a failed attempt' },
  { code: 'max_steps', en: 'Run hit its step limit', fix: { en: 'Simplify the brief of this slot; a run that takes too many steps is cut off.' } },
  { code: 'no_terminal', en: 'Run ended without a result', fix: { en: 'Try the slot again; if it repeats, simplify the brief.' } },
  { code: 'error', en: 'Run failed with an error', fix: { en: 'Open the run trace to see the error.' } },
  { code: 'disabled', en: 'Run switched off', fix: { en: 'Resume the agent or switch the editor on.' } },
  { code: 'stale', en: 'Missed its time window', fix: { en: 'Check that the editor was running at that time and that the budget was not used up.' } },
];

const BY_CODE = new Map<string, ReasonView>(REASONS.map((e) => [e.code, e]));

/** The entry of a server code. */
export const reasonView = (code: string | null | undefined): ReasonView | undefined => (code ? BY_CODE.get(code) : undefined);

/** The entry of the leading `<code>` or `<code>:` token of a slot error. The server's legacy-text mapping is not ported: an older text stays unclassified. */
export function reasonOfToken(error: string | null | undefined): ReasonView | undefined {
  const token = /^[a-z][a-z0-9_]*(?=$|[:\s])/.exec((error ?? '').trim())?.[0];
  return reasonView(token);
}

/** What a link can fill into its template. */
export interface ReasonLinkVars { channel?: string; agent?: string; dataset?: string }

/** Typed `Link` props, one member per route a reason points to (no string or `as any` casts: they defeat tsc). */
export type ReasonLinkProps =
  | { to: '/app/editor/$channel'; params: { channel: string } }
  | { to: '/app/agents/$handle'; params: { handle: string }; search?: { tab: AgentTab } }
  | { to: '/app/data/$key'; params: { key: string }; search?: { tab: DataTab } }
  | { to: '/app/agents/inbox'; search?: { tab: InboxTab } };

/**
 * The link of a reason for these variables, or null when the entry has no link, the template is unknown, or a placeholder is
 * not filled (the slot dialog then shows the fix line without a link). `?tab=<tab>` is checked against the page's own tabs;
 * an unknown tab falls back to the bare route.
 */
export function reasonLink(entry: { link?: string } | null | undefined, vars: ReasonLinkVars): ReasonLinkProps | null {
  if (!entry?.link) return null;
  const m = /^(\/app\/[a-z/:]+)(?:\?tab=([a-z]+))?$/.exec(entry.link);
  if (!m) return null;
  const tab = m[2];
  switch (m[1]) {
    case '/app/editor/:channel':
      return vars.channel ? { to: '/app/editor/$channel', params: { channel: vars.channel } } : null;
    case '/app/agents/:agent':
      if (!vars.agent) return null;
      return { to: '/app/agents/$handle', params: { handle: vars.agent }, ...(isAgentTab(tab) ? { search: { tab } } : {}) };
    case '/app/data/:dataset':
      if (!vars.dataset) return null;
      return { to: '/app/data/$key', params: { key: vars.dataset }, ...(isDataTab(tab) ? { search: { tab } } : {}) };
    case '/app/agents/inbox': {
      const t = INBOX_TABS.find((x) => x === tab);
      return { to: '/app/agents/inbox', ...(t ? { search: { tab: t } } : {}) };
    }
    default:
      return null;
  }
}
