export type PollerState = "idle" | "polling" | "reconnecting" | "stopped";

export type PollErrorKind = "retry" | "session" | "stop" | "rate_limit";

export type PollerCallbackSource = "onData" | "onState" | "onError";

type PollError = {
  status?: unknown;
  retryAfterMs?: unknown;
};

export type TaskPollerOptions<T, ScheduleHandle> = {
  fetchTasks: () => T | Promise<T>;
  shouldContinue: (data: T) => boolean;
  onData: (data: T) => void;
  onState: (state: PollerState) => void;
  onError: (error: unknown, kind: PollErrorKind) => void;
  onCallbackError?: (error: unknown, source: PollerCallbackSource) => void;
  schedule: (callback: () => void, delay: number) => ScheduleHandle;
  cancelSchedule: (handle: ScheduleHandle) => void;
  isVisible: () => boolean;
};

export type TaskPoller = {
  refresh: () => Promise<void>;
  setVisible: (visible: boolean) => Promise<void>;
  stop: () => void;
};

const MAX_TIMER_DELAY = 2_147_483_647;

export function getPollDelay(failureCount: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, MAX_TIMER_DELAY);
  }

  const normalizedFailureCount = Math.max(0, Math.floor(failureCount));
  return Math.min(5_000 * 2 ** normalizedFailureCount, 30_000);
}

export function classifyPollError(error: unknown): PollErrorKind {
  const status = getErrorStatus(error);

  if (status === 401) return "session";
  if (status === 403 || status === 404) return "stop";
  if (status === 429) return "rate_limit";
  return "retry";
}

export function createTaskPoller<T, ScheduleHandle>(
  options: TaskPollerOptions<T, ScheduleHandle>,
): TaskPoller {
  let failureCount = 0;
  let timer: ScheduleHandle | undefined;
  let stopped = false;
  let visibleOverride: boolean | undefined;
  let generation = 0;
  let inFlight: Promise<void> | undefined;

  const reportCallbackError = (error: unknown, source: PollerCallbackSource) => {
    try {
      options.onCallbackError?.(error, source);
    } catch {
      // Callback-error reporting must never recurse or escape the poller.
    }
  };

  const invokeCallback = (source: PollerCallbackSource, callback: () => void) => {
    try {
      callback();
    } catch (error) {
      reportCallbackError(error, source);
    }
  };

  const emitState = (state: PollerState) => {
    invokeCallback("onState", () => options.onState(state));
  };

  const clearTimer = () => {
    if (timer !== undefined) {
      options.cancelSchedule(timer);
      timer = undefined;
    }
  };

  const isCurrentlyVisible = () => visibleOverride ?? options.isVisible();

  const isCurrentPoll = (pollGeneration: number) => (
    !stopped && isCurrentlyVisible() && generation === pollGeneration
  );

  let refresh: () => Promise<void>;

  const scheduleNext = (delay: number) => {
    if (stopped || !isCurrentlyVisible()) return;

    clearTimer();
    timer = options.schedule(() => {
      timer = undefined;
      try {
        void refresh().catch(() => undefined);
      } catch {
        // A scheduler must never observe a thrown or rejected refresh.
      }
    }, delay);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    generation += 1;
    clearTimer();
    emitState("stopped");
  };

  const handleFetchError = (error: unknown, pollGeneration: number) => {
    if (!isCurrentPoll(pollGeneration)) return;

    const kind = classifyPollError(error);
    invokeCallback("onError", () => options.onError(error, kind));
    if (!isCurrentPoll(pollGeneration)) return;

    if (kind === "stop") {
      stop();
      return;
    }

    if (kind === "session") {
      emitState("idle");
      return;
    }

    emitState("reconnecting");
    if (!isCurrentPoll(pollGeneration)) return;

    const retryAfterMs = kind === "rate_limit" ? getRetryAfterMs(error) : undefined;
    const delay = getPollDelay(failureCount, retryAfterMs);
    failureCount += 1;
    scheduleNext(delay);
  };

  const poll = async (pollGeneration: number) => {
    if (!isCurrentPoll(pollGeneration)) return;

    clearTimer();
    emitState("polling");
    if (!isCurrentPoll(pollGeneration)) return;

    let data: T;
    try {
      data = await Promise.resolve().then(options.fetchTasks);
    } catch (error) {
      handleFetchError(error, pollGeneration);
      return;
    }

    if (!isCurrentPoll(pollGeneration)) return;

    failureCount = 0;
    invokeCallback("onData", () => options.onData(data));
    if (!isCurrentPoll(pollGeneration)) return;

    emitState("idle");
    if (!isCurrentPoll(pollGeneration)) return;

    let shouldContinue = false;
    try {
      shouldContinue = options.shouldContinue(data);
    } catch {
      return;
    }

    if (shouldContinue && isCurrentPoll(pollGeneration)) {
      scheduleNext(getPollDelay(0));
    }
  };

  refresh = () => {
    if (stopped || !isCurrentlyVisible()) return Promise.resolve();
    if (inFlight) return inFlight;

    const currentPoll = poll(generation);
    const trackedPoll = currentPoll.finally(() => {
      if (inFlight === trackedPoll) inFlight = undefined;
    });
    inFlight = trackedPoll;
    return trackedPoll;
  };

  const setVisible = (visible: boolean) => {
    visibleOverride = visible;
    generation += 1;

    if (!visible) {
      clearTimer();
      return Promise.resolve();
    }

    if (inFlight) {
      const stalePoll = inFlight;
      return stalePoll.catch(() => undefined).then(() => {
        if (stopped || !isCurrentlyVisible()) return;
        return refresh();
      });
    }

    return refresh();
  };

  return { refresh, setVisible, stop };
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as PollError).status;
  return typeof status === "number" ? status : undefined;
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const retryAfterMs = (error as PollError).retryAfterMs;
  return typeof retryAfterMs === "number" ? retryAfterMs : undefined;
}
