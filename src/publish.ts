import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLISH_SCRIPT = path.join(__dirname, '..', 'scripts', 'publish.sh');

/**
 * Publish a file, a directory or an archive (.zip/.tar.gz/.tgz/.tar).
 * Directories and archives are deployed as a whole tree into <name>-<hash>/
 * on the server, so relative links to images/CSS/JS keep working.
 * Returns the public URL (index.html for directories and archives).
 */
export async function publishFile(localPath: string, subfolder?: string): Promise<string | null> {
    try {
        const args = [localPath];
        if (subfolder) args.push(subfolder);

        const url = execFileSync(PUBLISH_SCRIPT, args, {
            encoding: 'utf-8',
            timeout: 180000,
            env: { ...process.env, BOT_DIR: process.env.BOT_DIR || '' },
        }).trim();

        // Warnings go to stderr, the URL is the last stdout line
        const lines = url.split('\n').filter((l) => l.trim());
        return lines.length ? lines[lines.length - 1].trim() : null;
    } catch (err) {
        console.error('Publish failed:', (err as Error).message);
        return null;
    }
}
