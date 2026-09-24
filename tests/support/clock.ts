import { getAppServices, setAppServices } from '@castlane/application';
import { fixedClock, systemClock, type Clock } from '@castlane/domain';

/** Move the application clock (deadlines, windows, TTLs) inside a test. */
export const setClock = (iso: string | Date): Clock => {
  const clock = fixedClock(iso);
  setAppServices(getAppServices(), clock);
  return clock;
};

export const resetClock = () => setAppServices(getAppServices(), systemClock);

/** Advance a mutable clock by minutes. */
export const mutableClock = (startIso: string) => {
  let t = new Date(startIso).getTime();
  const clock: Clock & { advance(minutes: number): void; set(iso: string): void } = {
    now: () => new Date(t),
    advance(minutes: number) {
      t += minutes * 60_000;
    },
    set(iso: string) {
      t = new Date(iso).getTime();
    },
  };
  setAppServices(getAppServices(), clock);
  return clock;
};
