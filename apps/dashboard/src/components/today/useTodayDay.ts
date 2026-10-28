// Spec 078 B1: the day's data for Today's schedule and the glance ring, read once: the editor channels (mode, runs, spend)
// and today's plans (the server defaults to the Kyiv date). The lanes and the ring both come from the plans query, so the
// ring and the timeline can never disagree; the Telegram lane is the slots with no `resourceRef`.

import { useMemo } from 'react';
import { useEditorChannels, useEditorPlans } from '../../api/editor';
import { buildLanes, otherPlatformCount, summarizeDay, telegramSlots } from '../../lib/today';

export function useTodayDay() {
  const channelsQ = useEditorChannels();
  const plansQ = useEditorPlans(undefined);

  const channels = channelsQ.data?.channels;
  const plans = plansQ.data?.plans;
  const day = plansQ.data?.date ?? channelsQ.data?.date ?? null;

  const lanes = useMemo(
    () => (plans && day ? buildLanes({ plans, channels, day }) : []),
    [plans, channels, day],
  );
  const summary = useMemo(() => summarizeDay(telegramSlots(plans)), [plans]);
  const otherPlatforms = useMemo(() => otherPlatformCount(plans), [plans]);

  return {
    channelsQ,
    plansQ,
    /** The Kyiv plan day ("2026-10-28"), null until either query answers. */
    day,
    channels,
    lanes,
    summary,
    /** Active-plan slots for Instagram, Facebook and Threads: counted apart, not drawn. */
    otherPlatforms,
    /** The editor feature is switched off on the server: nothing is planned. */
    editorOff: channelsQ.data ? !channelsQ.data.enabled : false,
    /** The plan could not be read at all. */
    failed: plansQ.isError && !plansQ.data,
    loading: plansQ.isLoading,
  };
}

export type TodayDay = ReturnType<typeof useTodayDay>;
