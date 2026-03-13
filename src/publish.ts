import { execSync } from 'child_process';
import path from 'path';

const PUBLISH_SCRIPT = path.join(__dirname, '..', 'scripts', 'publish.sh');

export async function publishFile(localPath: string, subfolder?: string): Promise<string | null> {
    try {
        const args = [PUBLISH_SCRIPT, localPath];
        if (subfolder) args.push(subfolder);

        const url = execSync(args.join(' '), {
            encoding: 'utf-8',
            timeout: 30000,
        }).trim();

        return url || null;
    } catch (err) {
        console.error('Publish failed:', (err as Error).message);
        return null;
    }
}
