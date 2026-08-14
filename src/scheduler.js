import { log, err } from './logger.js';

export class Scheduler {
  constructor({ dailyHour = 9, dailyMinute = 0 } = {}) {
    this.dailyHour = dailyHour;
    this.dailyMinute = dailyMinute;
    this.running = false;
    this.timer = null;
  }

  msUntilNextRun(now = new Date()) {
    const next = new Date(now);
    next.setHours(this.dailyHour, this.dailyMinute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  start(run) {
    const scheduleNext = () => {
      const delay = this.msUntilNextRun();
      log(`[scheduler] 下次日报任务 ${this.dailyHour}:${String(this.dailyMinute).padStart(2, '0')}，约 ${Math.round(delay / 60000)} 分钟后`);
      this.timer = setTimeout(() => {
        this._run(run);
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }

  async _run(run) {
    if (this.running) return;
    this.running = true;
    try {
      await run();
    } catch (e) {
      err('[scheduler] 日报任务出错:', e.message);
    } finally {
      this.running = false;
    }
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }
}
