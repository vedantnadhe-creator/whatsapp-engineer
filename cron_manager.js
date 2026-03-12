import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import config from './config.js';

class CronManager {
    constructor(claude, wa) {
        this.claude = claude;
        this.wa = wa;
        this.cronJobs = new Map();
        this.cronFilePath = path.join(config.DEFAULT_WORKING_DIR || process.cwd(), 'cron_jobs.json');

        // Ensure file exists
        if (!fs.existsSync(this.cronFilePath)) {
            try {
                fs.writeFileSync(this.cronFilePath, JSON.stringify([], null, 2));
            } catch (err) {
                console.error('[CronManager] Failed to create cron_jobs.json:', err);
            }
        }

        this.loadCrons();

        // Watch for changes to the JSON so Claude can edit it and we naturally pick it up
        fs.watch(this.cronFilePath, (eventType) => {
            if (eventType === 'change') {
                console.log('[CronManager] cron_jobs.json changed, reloading schedulers...');
                // debounce the reload safely
                clearTimeout(this.reloadTimer);
                this.reloadTimer = setTimeout(() => this.loadCrons(), 1000);
            }
        });
    }

    loadCrons() {
        try {
            if (!fs.existsSync(this.cronFilePath)) return;
            const content = fs.readFileSync(this.cronFilePath, 'utf8');
            const jobs = JSON.parse(content);

            if (!Array.isArray(jobs)) {
                console.error('[CronManager] cron_jobs.json MUST be an array of job objects');
                return;
            }

            // Stop all existing
            for (const [id, task] of this.cronJobs.entries()) {
                task.stop();
            }
            this.cronJobs.clear();

            // Start reading new crons
            jobs.forEach(job => {
                if (!job.id || !job.schedule || !job.task) {
                    console.warn(`[CronManager] Skipping invalid job configuration: ${JSON.stringify(job)}`);
                    return;
                }

                if (!cron.validate(job.schedule)) {
                    console.error(`[CronManager] Invalid cron expression: ${job.schedule} for job ${job.id}`);
                    return;
                }

                const scheduledTask = cron.schedule(job.schedule, async () => {
                    const ts = new Date().toISOString();
                    const logLine = JSON.stringify({ time: ts, jobId: job.id, task: job.task, status: 'triggered' });

                    console.log(`[CronManager] Executing cron job: ${job.id}`);
                    try {
                        fs.appendFileSync(path.join(config.DEFAULT_WORKING_DIR || process.cwd(), 'cron_logs.jsonl'), logLine + '\n');
                    } catch (e) { }
                    try {
                        const targetPhone = job.phone || 'system_cron'; // if a real phone is provided, user receives notifications
                        const { sessionId } = await this.claude.startSession(targetPhone, job.task, null);
                        try {
                            fs.appendFileSync(path.join(config.DEFAULT_WORKING_DIR || process.cwd(), 'cron_logs.jsonl'),
                                JSON.stringify({ time: new Date().toISOString(), jobId: job.id, session: sessionId, status: 'spawned' }) + '\n'
                            );
                        } catch (e) { }
                    } catch (err) {
                        try {
                            fs.appendFileSync(path.join(config.DEFAULT_WORKING_DIR || process.cwd(), 'cron_logs.jsonl'),
                                JSON.stringify({ time: new Date().toISOString(), jobId: job.id, error: err.message, status: 'failed' }) + '\n'
                            );
                        } catch (e) { }
                        console.error(`[CronManager] Error executing cron task ${job.id}:`, err);
                    }
                });

                this.cronJobs.set(job.id, scheduledTask);
            });
            console.log(`[CronManager] Loaded ${this.cronJobs.size} cron jobs.`);
        } catch (err) {
            console.error('[CronManager] Failed to read or parse cron_jobs.json:', err.message);
        }
    }
}

export default CronManager;
