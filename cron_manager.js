import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import config from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class CronManager {
    constructor(claude, wa) {
        this.claude = claude;
        this.wa = wa;
        this.cronJobs = new Map();
        // Store cron_jobs.json in the project directory, not the working dir
        this.cronFilePath = path.join(__dirname, 'cron_jobs.json');

        // Ensure file exists
        if (!fs.existsSync(this.cronFilePath)) {
            try {
                fs.writeFileSync(this.cronFilePath, JSON.stringify([], null, 2));
            } catch (err) {
                console.error('[CronManager] Failed to create cron_jobs.json:', err.message);
            }
        }

        this.loadCrons();

        // Watch for changes — wrapped in try/catch so it never crashes the process
        try {
            if (fs.existsSync(this.cronFilePath)) {
                fs.watch(this.cronFilePath, (eventType) => {
                    if (eventType === 'change') {
                        console.log('[CronManager] cron_jobs.json changed, reloading schedulers...');
                        clearTimeout(this.reloadTimer);
                        this.reloadTimer = setTimeout(() => this.loadCrons(), 1000);
                    }
                });
            }
        } catch (err) {
            console.warn('[CronManager] Could not watch cron_jobs.json:', err.message);
        }
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

            const logDir = __dirname;

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
                        fs.appendFileSync(path.join(logDir, 'cron_logs.jsonl'), logLine + '\n');
                    } catch (e) { }
                    try {
                        const targetPhone = job.phone || 'system_cron';
                        const { sessionId } = await this.claude.startSession(targetPhone, job.task, null);
                        try {
                            fs.appendFileSync(path.join(logDir, 'cron_logs.jsonl'),
                                JSON.stringify({ time: new Date().toISOString(), jobId: job.id, session: sessionId, status: 'spawned' }) + '\n'
                            );
                        } catch (e) { }
                    } catch (err) {
                        try {
                            fs.appendFileSync(path.join(logDir, 'cron_logs.jsonl'),
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
