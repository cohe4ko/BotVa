import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLISH_SCRIPT = path.join(__dirname, '..', 'scripts', 'publish.sh');

export async function publishFile(localPath: string, subfolder?: string): Promise<string | null> {
    try {
        const args = [localPath];
        if (subfolder) args.push(subfolder);

        const url = execFileSync(PUBLISH_SCRIPT, args, {
            encoding: 'utf-8',
            timeout: 30000,
            env: { ...process.env, BOT_DIR: process.env.BOT_DIR || '' },
        }).trim();

        return url || null;
    } catch (err) {
        console.error('Publish failed:', (err as Error).message);
        return null;
    }
}
