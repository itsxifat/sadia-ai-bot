// app/lib/task-queue.js
// Super-light FIFO queue with configurable concurrency.
// Use enqueue({ key, psid, run: async () => { ... } })

export class TaskQueue {
  constructor({ concurrency = 1 } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.running = 0;
    this.queue = [];
  }

  size() { return this.queue.length; }

  enqueue(job) {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this.running < this.concurrency && this.queue.length) {
      const { job, resolve, reject } = this.queue.shift();
      this.running++;
      Promise.resolve()
        .then(() => job.run())
        .then((result) => resolve(result))
        .catch((err) => reject(err))
        .finally(() => {
          this.running--;
          this._drain();
        });
    }
  }
}

// A shared global instance for YT jobs.
export const YT_QUEUE = new TaskQueue({ concurrency: Number(process.env.YT_CONCURRENCY || 1) });
